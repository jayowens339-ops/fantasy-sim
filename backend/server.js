// backend/server.js
// Fantasy Sim Backend – NFL + NBA
// DK CSV upload/URL + nflverse fallback (NFL)
// Stochastic multi-lineup generator with strict slot filling
// Injury filtering (OUT/IR/Q/DNP/PUP/INACTIVE/SUSP/RES)

const express = require("express");
const cors = require("cors");
const Papa = require("papaparse");

// ----------------- Config -----------------
const PORT            = process.env.PORT || 5000;
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || "Truetrenddfs4u!";
const CORS_ORIGIN     = process.env.CORS_ORIGIN || "*";
const DK_SALARIES_URL = process.env.DK_SALARIES_URL || "";   // optional public CSV URL
const REFRESH_MS      = 6 * 60 * 60 * 1000; // 6 hours

// ----------------- App --------------------
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "20mb" }));

// ----------------- State ------------------
let PLAYERS = [];         // {id,name,team,pos,proj,salary,sport}
let LAST_REFRESH = null;
let LAST_SOURCE  = null;
let CURRENT_SPORT = "NFL";

// ----------------- Utils ------------------
const n = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const trim = (s) => (s || "").toString().trim();
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const rnd = (a, b) => a + Math.random() * (b - a);
const fmt = (x, d = 2) => Number((x ?? 0).toFixed(d));
const uniqKey = (lineup) => lineup.map(p => p.id).sort().join("|");
const symDiffSize = (A, B) => {
  const a = new Set(A.map(p=>p.id)); let overlap=0;
  for (const p of B) if (a.has(p.id)) overlap++;
  return A.length + B.length - 2 * overlap;
};

// ----------------- SPORT CONFIG -----------
const ROSTERS = {
  NFL: {
    cap: 50000,
    // FLEX is strictly RB/WR/TE — no QB in FLEX
    slots: [
      { name: "QB",   allow: ["QB"] },
      { name: "RB1",  allow: ["RB"] },
      { name: "RB2",  allow: ["RB"] },
      { name: "WR1",  allow: ["WR"] },
      { name: "WR2",  allow: ["WR"] },
      { name: "WR3",  allow: ["WR"] },
      { name: "TE",   allow: ["TE"] },
      { name: "FLEX", allow: ["RB", "WR", "TE"] },
      { name: "DST",  allow: ["DST"] },
    ],
    stack: { needQBStack: true, minReceivers: 1, maxReceivers: 2 },
    avoidDstConflict: true,
    defaultMaxPerTeam: 3,
  },
  NBA: {
    cap: 50000, // DK Classic
    slots: [
      { name: "PG",   allow: ["PG"] },
      { name: "SG",   allow: ["SG"] },
      { name: "SF",   allow: ["SF"] },
      { name: "PF",   allow: ["PF"] },
      { name: "C",    allow: ["C"] },
      { name: "G",    allow: ["PG","SG"] },
      { name: "F",    allow: ["SF","PF"] },
      { name: "UTIL", allow: ["PG","SG","SF","PF","C"] },
    ],
    stack: null,
    avoidDstConflict: false,
    defaultMaxPerTeam: 3,
  }
};

// ----------------- DK CSV parsing ----------
function detectSportFromPositions(posSet) {
  const nfl = ["QB","RB","WR","TE","DST"].some(p => posSet.has(p));
  const nba = ["PG","SG","SF","PF","C","G","F","UTIL"].some(p => posSet.has(p));
  if (nba && !nfl) return "NBA";
  if (nfl && !nba) return "NFL";
  if (nba) return "NBA";
  return "NFL";
}

// Injury filter terms (upper-case checks)
const INJURY_TERMS = ["OUT", "IR", "Q", "DNP", "PUP", "SUSP", "RES", "INACTIVE"];

function isInjuredDK(row, nameUpper) {
  const status = (row.InjuryStatus || row.Status || "").toUpperCase();
  const note   = (row.InjuryNotes || row.Note || "").toUpperCase();

  const tagHit = INJURY_TERMS.some(t => status.includes(t) || note.includes(t));
  const nameHit = nameUpper.includes("(IR)") || nameUpper.includes("(OUT)") || nameUpper.includes("(Q)");
  return tagHit || nameHit;
}

function parseDKCsvToPlayers(csvText) {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const rows = parsed.data || [];
  const players = [];
  const posSet = new Set();

  for (const r of rows) {
    const posRaw = trim(r.Position || r["Roster Position"] || r["Roster Positions"] || r["RosterPosition"]);
    if (!posRaw) continue;
    const primary = posRaw.split(/[\/,]/)[0].toUpperCase();
    posSet.add(primary);

    const id = trim(r.ID || r["Player ID"] || r["DraftKings ID"] || r["ID"]);
    const name = trim(r.Name || r["Player Name"] || r.Player || "");
    const team = trim(r.TeamAbbrev || r.Team || r["Team Abbrev"] || "");
    const salary = n(r.Salary || r["DK Salary"] || r["Salary (DK)"]);
    const proj = n(r.AvgPointsPerGame || r["Avg Points/GM"] || r.Projection || r.Proj || r.FPPG);

    // --- Injury filtering ---
    if (isInjuredDK(r, name.toUpperCase())) continue;

    if (!name || !primary || !salary) continue;

    players.push({
      id: id || `${name}_${team}_${primary}`,
      name,
      team: team.toUpperCase(),
      pos: primary,
      salary,
      proj
    });
  }

  // de-dupe prefer highest projection
  const map = new Map();
  for (const p of players) {
    if (!map.has(p.id) || (p.proj || 0) > (map.get(p.id).proj || 0)) map.set(p.id, p);
  }
  const list = Array.from(map.values());

  const sport = detectSportFromPositions(posSet);
  if (sport === "NFL") {
    for (const p of list) {
      if (p.pos === "DST") p.name = `${p.team || p.name} D/ST`;
    }
  }

  console.log(`✅ Loaded ${list.length} active ${sport} players (injured filtered out)`);
  return { players: list.map(p=>({ ...p, sport })), sport };
}

async function loadDKFromUrl(url) {
  const resp = await fetch(url, { headers: { "User-Agent": "fantasy-sim/1.0" } });
  if (!resp.ok) throw new Error(`DK CSV fetch failed: HTTP ${resp.status}`);
  const csv = await resp.text();
  const { players, sport } = parseDKCsvToPlayers(csv);
  if (!players.length) throw new Error("No players parsed from DK CSV");
  PLAYERS = players;
  CURRENT_SPORT = sport;
  LAST_REFRESH = new Date().toISOString();
  LAST_SOURCE = "draftkings";
  return { ok: true, count: PLAYERS.length, sport, source: LAST_SOURCE };
}

// --------------- nflverse fallback (NFL only) ---------------
const NOW_YEAR = new Date().getFullYear();
const TRY_SEASONS = [NOW_YEAR, NOW_YEAR - 1];
const playerWeekUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${season}.csv`;
const teamWeekUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/team_stats/stats_team_week_${season}.csv`;

function pprRow(r) {
  const passY = n(r.passing_yards || r.pass_yds);
  const passT = n(r.passing_tds   || r.pass_td);
  const ints  = n(r.interceptions  || r.int);
  const rushY = n(r.rushing_yards  || r.rush_yds);
  const rushT = n(r.rushing_tds    || r.rush_td);
  const rec   = n(r.receptions     || r.rec);
  const recY  = n(r.receiving_yards|| r.rec_yds);
  const recT  = n(r.receiving_tds  || r.rec_td);
  const fumL  = n(r.fumbles_lost   || r.fumbles_lost_offense || r.fum_lost);
  let pts = 0;
  pts += passY * 0.04 + passT * 4 - ints * 1;
  pts += rushY * 0.1  + rushT * 6;
  pts += rec * 1 + recY * 0.1 + recT * 6;
  pts -= fumL * 2;
  return pts;
}
function weightedProj(arr) {
  if (!arr.length) return 0;
  const L = arr.slice(-3);
  if (L.length === 1) return fmt(L[0]);
  if (L.length === 2) return fmt(L[1]*0.3 + L[0]*0.7);
  return fmt(L[2]*0.2 + L[1]*0.3 + L[0]*0.5);
}
function seasonAvg(arr) {
  if (!arr.length) return 0;
  return fmt(arr.reduce((a,b)=>a+b,0)/arr.length);
}
function salaryFromProj(pos, proj) {
  let base;
  switch(pos){
    case "QB":  base = 2200 + 425*proj; break;
    case "RB":  base = 2300 + 380*proj; break;
    case "WR":  base = 2300 + 370*proj; break;
    case "TE":  base = 2000 + 410*proj; break;
    case "DST": base = 2200 + 250*proj; break;
    default:    base = 2500 + 350*proj;
  }
  return clamp(Math.round(base), 2500, 9900);
}
function buildOffense(rows){
  const byId = new Map();
  for (const r of rows) {
    const pos = (r.position || r.pos || "").toUpperCase();
    if (!["QB","RB","WR","TE"].includes(pos)) continue;
    const pid = r.player_id || r.gsis_id || r.pfr_player_id || r.pfr_id ||
                `${r.player_name}_${pos}_${r.recent_team || r.team}`;
    if (!byId.has(pid)) byId.set(pid, []);
    byId.get(pid).push(r);
  }
  const out = [];
  for (const [pid, list] of byId.entries()) {
    list.sort((a,b)=> n(a.week)-n(b.week) );
    const pts = list.map(pprRow);
    let proj = weightedProj(pts);
    if (proj === 0) proj = seasonAvg(pts);
    const latest = list[list.length-1];
    const name = latest.player_name || latest.name || "Unknown";
    const team = (latest.recent_team || latest.team || latest.posteam || "").toUpperCase();
    const pos  = (latest.position || latest.pos || "").toUpperCase();
    if (!name || !pos) continue;
    out.push({ id:pid, name, team:team||"FA", pos, proj, salary: salaryFromProj(pos, proj), sport:"NFL" });
  }
  return out;
}
function buildDST(rows){
  const byTeam = new Map();
  for(const r of rows){
    const team=(r.team||r.recent_team||r.posteam||r.defteam||"").toUpperCase();
    if(!team || team.length>3) continue;
    if(!byTeam.has(team)) byTeam.set(team,[]);
    byTeam.get(team).push(r);
  }
  const pointsAllowedToDST = (pa)=>{
    if(pa===0) return 10;
    if(pa<=6)  return 7;
    if(pa<=13) return 4;
    if(pa<=20) return 1;
    if(pa<=27) return 0;
    if(pa<=34) return -1;
    return -4;
  };
  const out=[];
  for(const [team,list] of byTeam.entries()){
    list.sort((a,b)=> n(a.week)-n(b.week) );
    const pts = list.map(r=>{
      const sacks   = n(r.defense_sacks || r.sacks);
      const ints    = n(r.defense_interceptions || r.interceptions);
      const fumRec  = n(r.defense_fumbles || r.fumbles_recovered || r.fumble_recoveries);
      const tds     = n(r.defense_touchdowns || r.td || r.touchdowns);
      const safeties= n(r.defense_safeties || r.safeties);
      const pa      = n(r.points_allowed || r.points_against || r.opp_points);
      return sacks*1 + ints*2 + fumRec*2 + tds*6 + safeties*2 + pointsAllowedToDST(pa);
    });
    let proj = weightedProj(pts);
    if (proj === 0) proj = seasonAvg(pts);
    out.push({ id:`DST_${team}`, name:`${team} D/ST`, team, pos:"DST", proj, salary: salaryFromProj("DST",proj), sport:"NFL" });
  }
  return out;
}
async function fetchSeason(season){
  const [pRes,tRes] = await Promise.all([
    fetch(playerWeekUrl(season), { headers:{ "User-Agent":"fantasy-sim/1.0" } }),
    fetch(teamWeekUrl(season),   { headers:{ "User-Agent":"fantasy-sim/1.0" } }),
  ]);
  if(!pRes.ok) throw new Error(`players ${season}: HTTP ${pRes.status}`);
  if(!tRes.ok) throw new Error(`teams ${season}: HTTP ${tRes.status}`);
  const [pText,tText] = await Promise.all([pRes.text(), tRes.text()]);
  const pParsed = Papa.parse(pText, { header:true, skipEmptyLines:true });
  const tParsed = Papa.parse(tText, { header:true, skipEmptyLines:true });

  const offense = buildOffense(pParsed.data || []);
  const dst     = buildDST(tParsed.data || []);
  const all     = [...offense, ...dst].filter(p=>p.name&&p.pos);
  return { players: all, count: all.length, source: `nflverse ${season}` };
}
async function refreshNflverse(){
  const errs=[];
  for(const season of TRY_SEASONS){
    try{
      const { players, count, source } = await fetchSeason(season);
      if(!count) { errs.push(`${season}: 0 players`); continue; }
      PLAYERS = players;
      CURRENT_SPORT = "NFL";
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = source;
      return { ok:true, season, count, source, sport: CURRENT_SPORT };
    }catch(e){ errs.push(`${season}: ${e.message}`); }
  }
  throw new Error(errs.join(" | "));
}

// --------------- freshness ---------------
async function ensureFresh(){
  if (!PLAYERS.length) {
    try {
      if (DK_SALARIES_URL) await loadDKFromUrl(DK_SALARIES_URL);
      else await refreshNflverse();
    } catch {
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE = "empty";
    }
    return;
  }
  if (Date.now() - Date.parse(LAST_REFRESH || 0) > REFRESH_MS) {
    try {
      if (LAST_SOURCE === "draftkings" && DK_SALARIES_URL) await loadDKFromUrl(DK_SALARIES_URL);
      else await refreshNflverse();
    } catch {/* keep previous pool */}
  }
}
setInterval(()=>{ ensureFresh().catch(()=>{}); }, 30*60*1000);
ensureFresh().catch(()=>{});

// ----------------- Optimizer core -----------------
function sortByValue(arr, temperature=0){
  // Value density with small randomized jitter
  return [...arr].sort((a,b)=>{
    const va = (a.projAdj)/Math.max(1,a.salary) + (temperature ? rnd(-temperature,temperature)/1000 : 0);
    const vb = (b.projAdj)/Math.max(1,b.salary) + (temperature ? rnd(-temperature,temperature)/1000 : 0);
    if (vb !== va) return vb - va;
    return (b.projAdj - a.projAdj);
  });
}

function buildLineupStrict(players, rosterCfg, {
  salaryCap,
  noise = 1.0,
  temperature = 0.6,
  maxPerTeam = rosterCfg.defaultMaxPerTeam,
  tries = 300
} = {}){
  const cap = salaryCap || rosterCfg.cap;
  let best = null;

  for(let attempt=0; attempt<tries; attempt++){
    const pool = players.map(p => ({ ...p, projAdj: p.proj + (noise ? rnd(-noise, noise) : 0) }));
    const poolByPos = pool.reduce((m,p)=>{ (m[p.pos] ||= []).push(p); return m; }, {});
    for(const pos in poolByPos) poolByPos[pos] = sortByValue(poolByPos[pos], temperature);

    const taken = new Set();
    const teamCount = {};
    const lineup = [];
    let used = 0;

    function canAdd(p, addingPos){
      if (taken.has(p.id)) return false;
      if (used + p.salary > cap) return false;
      const cnt = (teamCount[p.team]||0) + 1;
      if (maxPerTeam && cnt > maxPerTeam) return false;

      // NFL-only conflicts with DST
      if (rosterCfg.avoidDstConflict){
        if (addingPos === "DST"){
          if (lineup.some(x => x.pos !== "DST" && x.team === p.team)) return false;
        } else {
          if (lineup.some(x => x.pos === "DST" && x.team === p.team)) return false;
        }
      }
      return true;
    }
    function add(p){
      taken.add(p.id);
      teamCount[p.team] = (teamCount[p.team]||0) + 1;
      lineup.push(p);
      used += p.salary;
    }

    // Fill each slot strictly by allowed positions.
    for (const slot of rosterCfg.slots) {
      const allowed = slot.allow;

      // merged candidate list for this slot
      let cands = [];
      for (const pos of allowed) {
        if (poolByPos[pos]) cands = cands.concat(poolByPos[pos].filter(x=>!taken.has(x.id)));
      }
      // small random pick from top K to diversify
      const K = Math.max(5, Math.ceil(cands.length * 0.15));
      cands = cands.slice(0, K);

      const pick = cands.find(p => canAdd(p, allowed.length===1 ? allowed[0] : p.pos));
      if (!pick) {
        // widen to top 25%
        let more = [];
        for (const pos of allowed) {
          if (poolByPos[pos]) more = more.concat(poolByPos[pos].filter(x=>!taken.has(x.id)));
        }
        more = more.slice(0, Math.max(K, Math.ceil(more.length*0.25)));
        const alt = more.find(p => canAdd(p, allowed.length===1 ? allowed[0] : p.pos));
        if (!alt) { lineup.length = 0; break; } // give up this attempt
        add(alt);
        continue;
      }
      add(pick);
    }

    if (lineup.length !== rosterCfg.slots.length) continue;

    // NFL stack requirement: at least minReceivers WR/TE on same team as QB
    if (rosterCfg.stack?.needQBStack) {
      const qb = lineup.find(p => p.pos === "QB");
      if (!qb) continue;
      const recs = lineup.filter(p => (p.pos === "WR" || p.pos === "TE") && p.team === qb.team);
      if (recs.length < (rosterCfg.stack.minReceivers || 1)) continue;
    }

    const totalProj = fmt(lineup.reduce((s,p)=> s + (p.projAdj || p.proj || 0), 0));
    const candidate = { usedSalary: used, totalProj, lineup: lineup.map(({projAdj, ...rest})=>rest) };
    if (!best || candidate.totalProj > best.totalProj || (candidate.totalProj===best.totalProj && candidate.usedSalary<best.usedSalary)){
      best = candidate;
    }
  }
  return best;
}

function generateLineups(players, rosterCfg, {
  salaryCap,
  count = 20,
  noise = 1.2,
  temperature = 0.6,
  maxPerTeam = rosterCfg.defaultMaxPerTeam,
  minDiff = (rosterCfg === ROSTERS.NFL ? 4 : 3),
  triesPerLineup = 300
} = {}){
  const out = [];
  const seen = new Set();

  while (out.length < count) {
    const cand = buildLineupStrict(players, rosterCfg, { salaryCap, noise, temperature, maxPerTeam, tries: triesPerLineup });
    if (!cand) break;

    // diversity & duplicate check
    let unique = true;
    for (const L of out) {
      if (symDiffSize(L.lineup, cand.lineup) < minDiff) { unique = false; break; }
    }
    const key = uniqKey(cand.lineup);
    if (seen.has(key)) unique = false;

    if (unique) {
      out.push(cand);
      seen.add(key);
    } else {
      // slightly increase randomness to search new space
      noise *= 1.02;
      temperature *= 1.02;
    }
    if (out.length === 0 && noise < 2.5) noise += 0.05;
  }

  out.sort((a,b)=> (b.totalProj - a.totalProj) || (a.usedSalary - b.usedSalary));
  return out;
}

// ----------------- Routes -----------------
app.get("/", (_req,res)=> res.redirect("/api/health"));

app.get("/api/health", (_req,res)=>{
  res.json({
    ok: true,
    players: PLAYERS.length,
    lastRefresh: LAST_REFRESH,
    source: LAST_SOURCE,
    sport: CURRENT_SPORT,
    time: new Date().toISOString()
  });
});

app.get("/api/players", async (_req,res)=>{
  try { await ensureFresh(); res.json({ players: PLAYERS, sport: CURRENT_SPORT }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// Multi-lineup, SPORT-AWARE
app.post("/api/lineups/optimize", async (req,res)=>{
  try { await ensureFresh(); } catch {}
  const body = req.body || {};
  const c = body.constraints || {};

  const sport = (c.sport || CURRENT_SPORT || "NFL").toUpperCase();
  const roster = ROSTERS[sport] || ROSTERS.NFL;

  const salaryCap    = Number(c.salaryCap ?? roster.cap);
  const count        = Number(c.numLineups ?? body.count ?? 1);
  const noise        = Number(c.noise ?? 1.2);
  const temperature  = Number(c.temperature ?? 0.6);
  const maxPerTeam   = Number(c.maxPerTeam ?? roster.defaultMaxPerTeam);
  const minDiff      = Number(c.minDiff ?? (sport === "NFL" ? 4 : 3));
  const triesPerLineup = Number(c.triesPerLineup ?? 300);

  const pool = PLAYERS.filter(p => (p.sport || CURRENT_SPORT) === sport);
  if (!pool.length) return res.json({ salaryCap, count:0, lineups:[], sport, error:"No players loaded for this sport" });

  if (count <= 1) {
    const one = buildLineupStrict(pool, roster, { salaryCap, noise, temperature, maxPerTeam, tries: triesPerLineup });
    return res.json(one || { error:"Could not build a lineup. Check pool/constraints." });
  }

  const many = generateLineups(pool, roster, { salaryCap, count, noise, temperature, maxPerTeam, minDiff, triesPerLineup });
  res.json({ salaryCap, count: many.length, lineups: many, sport });
});

// Legacy single lineup (kept for compatibility)
app.post("/api/optimize", async (req,res)=>{
  try { await ensureFresh(); } catch {}
  const cap = Number(req.body?.salaryCap ?? ROSTERS[CURRENT_SPORT]?.cap ?? 50000);
  const roster = ROSTERS[CURRENT_SPORT] || ROSTERS.NFL;
  const pool = PLAYERS.filter(p => (p.sport || CURRENT_SPORT) === CURRENT_SPORT);
  if (!pool.length) return res.json({ error:"No players loaded" });
  const one = buildLineupStrict(pool, roster, { salaryCap: cap, noise: 1.0, temperature: 0.6, maxPerTeam: roster.defaultMaxPerTeam, tries: 300 });
  res.json(one || { error:"Could not build a lineup. Check player pool." });
});

// Admin: refresh NFL from nflverse
app.post("/api/admin/refresh", async (req,res)=>{
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error:"Unauthorized" });
  try {
    const info = await refreshNflverse();
    res.json({ ok:true, ...info });
  } catch(e){
    res.status(500).json({ error:String(e.message||e) });
  }
});

// Admin: DK loader (CSV or URL) — auto sport detect, injury-filter aware
app.post("/api/admin/dk", async (req,res)=>{
  const token = req.headers["x-admin-token"] || "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error:"Unauthorized" });

  const rawCsv = trim(req.body?.csv || "");
  const url    = trim(req.body?.url || "");

  try {
    if (rawCsv) {
      const { players, sport } = parseDKCsvToPlayers(rawCsv);
      if (!players.length) throw new Error("No players in CSV");
      PLAYERS = players;
      CURRENT_SPORT = sport;
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = "draftkings";
      return res.json({ ok:true, count: PLAYERS.length, sport, source: LAST_SOURCE });
    }
    if (url) {
      const info = await loadDKFromUrl(url);
      return res.json(info);
    }
    return res.status(400).json({ error:"Provide either { csv } or { url }" });
  } catch(e){
    res.status(500).json({ error:String(e.message||e) });
  }
});

// ----------------- Start -----------------
app.listen(PORT, "0.0.0.0", ()=>{
  console.log(`Fantasy backend running on port ${PORT}`);
});
