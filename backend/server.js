// backend/server.js
// Fantasy Sim backend — DK CSV upload/URL + nflverse fallback + MULTI-SPORT (NFL + NBA)
// Stochastic multi-lineup generator with noise, temperature, minDiff, maxPerTeam.

const express = require("express");
const cors = require("cors");
const Papa = require("papaparse");

// ---------- Config ----------
const PORT            = process.env.PORT || 5000;
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || "Truetrenddfs4u!";
const CORS_ORIGIN     = process.env.CORS_ORIGIN || "*";
const DK_SALARIES_URL = process.env.DK_SALARIES_URL || ""; // optional public CSV
const REFRESH_MS      = 6 * 60 * 60 * 1000; // 6h

// ---------- App ----------
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "20mb" })); // allow big CSV bodies

// ---------- State ----------
let PLAYERS = []; // {id,name,team,pos,proj,salary, sport}
let LAST_REFRESH = null;
let LAST_SOURCE  = null;
let CURRENT_SPORT = "NFL"; // "NFL" | "NBA" (auto-detected on DK load)

// ---------- Helpers ----------
const n = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const trim = (s) => (s || "").toString().trim();
const rnd = (min, max) => min + Math.random() * (max - min);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fmt = (x, d=2) => Number((x ?? 0).toFixed(d));
const uniqKey = (lineup) => lineup.map(p=>p.id).sort().join("|");
const hamming = (A,B) => {
  const a = new Set(A.map(p=>p.id)); let overlap=0;
  for(const p of B) if(a.has(p.id)) overlap++;
  return A.length + B.length - 2*overlap; // size-based symmetric diff
};

// ---------- SPORT CONFIG ----------
const ROSTERS = {
  NFL: {
    cap: 50000,
    slots: [
      { name:"QB",   allow:["QB"] },
      { name:"RB1",  allow:["RB"] },
      { name:"RB2",  allow:["RB"] },
      { name:"WR1",  allow:["WR"] },
      { name:"WR2",  allow:["WR"] },
      { name:"WR3",  allow:["WR"] },
      { name:"TE",   allow:["TE"] },
      { name:"FLEX", allow:["RB","WR","TE"] },
      { name:"DST",  allow:["DST"] },
    ],
    stack: { needQBStack: true, minReceivers: 1, maxReceivers: 2 }, // WR/TE from QB team
    avoidDstConflict: true,
    defaultMaxPerTeam: 3,
  },
  NBA: {
    cap: 50000, // DK classic
    slots: [
      { name:"PG",   allow:["PG"] },
      { name:"SG",   allow:["SG"] },
      { name:"SF",   allow:["SF"] },
      { name:"PF",   allow:["PF"] },
      { name:"C",    allow:["C"]  },
      { name:"G",    allow:["PG","SG"] },
      { name:"F",    allow:["SF","PF"] },
      { name:"UTIL", allow:["PG","SG","SF","PF","C"] },
    ],
    stack: null, // no forced stacks for NBA
    avoidDstConflict: false,
    defaultMaxPerTeam: 3,
  }
};

// ---------- DK CSV parsing & sport detection ----------
function detectSportFromPositions(posSet){
  const hasNFL = posSet.has("QB") || posSet.has("RB") || posSet.has("WR") || posSet.has("TE") || posSet.has("DST");
  const hasNBA = posSet.has("PG") || posSet.has("SG") || posSet.has("SF") || posSet.has("PF") || posSet.has("C") || posSet.has("UTIL") || posSet.has("G") || posSet.has("F");
  if (hasNBA && !hasNFL) return "NBA";
  if (hasNFL && !hasNBA) return "NFL";
  // If mixed, prefer NBA when NBA-only slots present
  if (hasNBA) return "NBA";
  return "NFL";
}

function parseDKCsvToPlayers(csvText){
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const rows = parsed.data || [];
  const players = [];
  const posSet = new Set();

  for(const r of rows){
    const posRaw = trim(r.Position || r["Roster Position"] || r["Roster Positions"] || r["RosterPosition"]);
    if (!posRaw) continue;
    const primary = posRaw.split(/[\/,]/)[0].toUpperCase();
    posSet.add(primary);

    const id = trim(r.ID || r["Player ID"] || r["DraftKings ID"] || r["ID"]);
    const name = trim(r.Name || r["Player Name"] || r.Player || "");
    const team = trim(r.TeamAbbrev || r.Team || r["Team Abbrev"] || "");
    const salary = n(r.Salary || r["DK Salary"] || r["Salary (DK)"]);
    const proj = n(r.AvgPointsPerGame || r["Avg Points/GM"] || r.Projection || r.Proj || r.FPPG);

    if (!name || !primary || !salary) continue;

    // Normalize DST naming on NFL slates later after sport detection.
    players.push({
      id: id || `${name}_${team}_${primary}`,
      name,
      team: team.toUpperCase(),
      pos: primary,
      salary,
      proj
    });
  }

  // De-dupe best projection
  const map = new Map();
  for (const p of players) {
    if (!map.has(p.id) || (p.proj||0) > (map.get(p.id).proj||0)) map.set(p.id, p);
  }
  const list = Array.from(map.values());

  // Infer sport & normalize if NFL/DST
  const sport = detectSportFromPositions(posSet);
  if (sport === "NFL") {
    for (const p of list) {
      if (p.pos === "DST") p.name = `${p.team || p.name} D/ST`;
    }
  }

  return { players: list.map(p=>({ ...p, sport })), sport };
}

async function loadDKFromUrl(url){
  const resp = await fetch(url, { headers: { "User-Agent": "fantasy-sim/1.0" }});
  if(!resp.ok) throw new Error(`DK CSV fetch failed: HTTP ${resp.status}`);
  const csvText = await resp.text();
  const { players, sport } = parseDKCsvToPlayers(csvText);
  if(!players.length) throw new Error("No players in DK CSV (or unexpected headers)");
  PLAYERS = players;
  CURRENT_SPORT = sport;
  LAST_REFRESH = new Date().toISOString();
  LAST_SOURCE = "draftkings";
  return { ok: true, count: PLAYERS.length, source: LAST_SOURCE, sport: CURRENT_SPORT };
}

// ---------- nflverse fallback (NFL only) ----------
const NOW_YEAR = new Date().getFullYear();
const TRY_SEASONS = [NOW_YEAR, NOW_YEAR - 1];

const playerWeekUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${season}.csv`;
const teamWeekUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/team_stats/stats_team_week_${season}.csv`;

function pprRow(r){
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
function weightedProj(points){
  if (!points.length) return 0;
  const L = points.slice(-3);
  if (L.length === 1) return fmt(L[0]);
  if (L.length === 2) return fmt(L[1]*0.3 + L[0]*0.7);
  return fmt(L[2]*0.2 + L[1]*0.3 + L[0]*0.5);
}
function seasonAvg(points){
  if (!points.length) return 0;
  return fmt(points.reduce((a,b)=>a+b,0)/points.length);
}
function salaryFromProj(pos, proj){
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
  for(const r of rows){
    const pos=(r.position||r.pos||"").toUpperCase();
    if(!["QB","RB","WR","TE"].includes(pos)) continue;
    const pid = r.player_id || r.gsis_id || r.pfr_player_id || r.pfr_id ||
                `${r.player_name}_${pos}_${r.recent_team||r.team}`;
    if(!byId.has(pid)) byId.set(pid,[]);
    byId.get(pid).push(r);
  }
  const out=[];
  for(const [pid,list] of byId.entries()){
    list.sort((a,b)=> n(a.week)-n(b.week) );
    const pts = list.map(pprRow);
    let proj = weightedProj(pts);
    if (proj === 0) proj = seasonAvg(pts);
    const latest = list[list.length-1];
    const name = latest.player_name || latest.name || latest.player || "Unknown";
    const team = (latest.recent_team || latest.team || latest.posteam || "").toUpperCase();
    const pos  = (latest.position || latest.pos || "").toUpperCase();
    if (!name || !pos) continue;
    out.push({ id:pid, name, team: team||"FA", pos, proj, salary: salaryFromProj(pos, proj), sport:"NFL" });
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
  const pointsAllowedToDST=(pa)=>{
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
    out.push({ id:`DST_${team}`, name:`${team} D/ST`, team, pos:"DST", proj, salary: salaryFromProj("DST", proj), sport:"NFL" });
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
  const tries=[];
  for(const season of TRY_SEASONS){
    try{
      const { players, count, source } = await fetchSeason(season);
      if(!count){ tries.push(`${season}: 0 players`); continue; }
      PLAYERS = players;
      CURRENT_SPORT = "NFL";
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = source;
      return { ok:true, season, count, source, sport: CURRENT_SPORT };
    }catch(e){ tries.push(`${season}: ${e.message}`); }
  }
  throw new Error(tries.join(" | "));
}

// ---------- Data freshness ----------
async function ensureFresh(){
  if (!PLAYERS.length) {
    try {
      if (DK_SALARIES_URL) await loadDKFromUrl(DK_SALARIES_URL);
      else await refreshNflverse(); // NFL-only fallback
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
    } catch { /* keep old */ }
  }
}
setInterval(()=>{ ensureFresh().catch(()=>{}); }, 30*60*1000);
ensureFresh().catch(()=>{});

// ---------- Generic slot-based optimizer ----------
function byPos(players){
  const m = {};
  for(const p of players){
    if(!m[p.pos]) m[p.pos]=[];
    m[p.pos].push(p);
  }
  return m;
}
function sortByValue(arr, temperature=0){
  // value density + stochastic jitter controlled by temperature
  return [...arr].sort((a,b)=>{
    const va = (a.proj||0)/Math.max(1,a.salary||1) + (temperature ? rnd(-temperature, temperature)/1000 : 0);
    const vb = (b.proj||0)/Math.max(1,b.salary||1) + (temperature ? rnd(-temperature, temperature)/1000 : 0);
    if (vb !== va) return vb - va;
    return (b.proj||0) - (a.proj||0);
  });
}

function buildLineup(players, sportCfg, { salaryCap, noise=0, temperature=0, maxPerTeam, minTries=200 }){
  const cap = salaryCap || sportCfg.cap;
  const pools = byPos(players.map(p => ({ ...p, projAdj: p.proj + (noise ? rnd(-noise, noise) : 0) })));
  const allPool = sortByValue(players.map(p => ({ ...p, projAdj: p.proj + (noise ? rnd(-noise, noise) : 0) })), temperature);
  const dstTeams = new Set((pools.DST||[]).map(d=>d.team));

  // Try multiple random-ish builds, keep the best that satisfies constraints
  let best = null;

  for(let attempt=0; attempt<minTries; attempt++){
    const lineup = [];
    const taken = new Set();
    const teamCount = {};

    let used = 0;

    function canAdd(p){
      if (taken.has(p.id)) return false;
      if (used + p.salary > cap) return false;
      const cnt = (teamCount[p.team] || 0) + 1;
      if (maxPerTeam && cnt > maxPerTeam) return false;
      // NFL only: avoid DST conflict (no offensive player from same DST team)
      if (sportCfg.avoidDstConflict && p.pos !== "DST") {
        if (lineup.some(x => x.pos==="DST" && x.team === p.team)) return false;
      }
      if (sportCfg.avoidDstConflict && p.pos === "DST") {
        if (lineup.some(x => x.pos!=="DST" && x.team === p.team)) return false;
      }
      return true;
    }
    function add(p){
      lineup.push(p); taken.add(p.id); used += p.salary; teamCount[p.team] = (teamCount[p.team]||0) + 1;
    }

    // If NFL and stack is required: pick QB and 1-2 teammates first
    if (sportCfg.stack?.needQBStack) {
      const qbs = sortByValue(pools.QB||[], temperature).slice(0,12);
      const qb = qbs[Math.floor(Math.random()*Math.max(1,qbs.length))];
      if (!qb || !canAdd(qb)) continue;
      add(qb);

      const recPool = [...(pools.WR||[]), ...(pools.TE||[])].filter(x => x.team === qb.team);
      const recSorted = sortByValue(recPool, temperature);
      let added=0;
      for(const r of recSorted){
        if (added >= sportCfg.stack.maxReceivers) break;
        if (canAdd(r)) { add(r); added++; if (added >= sportCfg.stack.minReceivers) break; }
      }
      if (added < sportCfg.stack.minReceivers) continue;

      // DST pick (avoid QB/stack team)
      const dstSorted = sortByValue(pools.DST||[], temperature);
      const dst = dstSorted.find(d => canAdd(d));
      if (!dst) continue;
      add(dst);
    }

    // Fill remaining slots generically against allowed positions list
    for (const slot of sportCfg.slots) {
      // Skip if already satisfied (e.g., we added QB, a WR, and DST above)
      const have = lineup.filter(p => slot.allow.includes(p.pos)).length;
      if (have >= 1 && !["RB2","WR2","WR3"].includes(slot.name)) continue;

      const allowed = slot.allow;
      const candidates = sortByValue(allPool.filter(p => allowed.includes(p.pos) && !taken.has(p.id)), temperature);
      const pick = candidates.find(p => canAdd(p));
      if (!pick) { /* fail this attempt */ best = best; continue; } // we'll evaluate final size later
      add(pick);
    }

    // If we don’t have the right number of players yet, try to fill from best available
    while (lineup.length < sportCfg.slots.length) {
      const candidates = sortByValue(allPool.filter(p => !taken.has(p.id)), temperature);
      const pick = candidates.find(p => canAdd(p));
      if (!pick) break;
      add(pick);
    }

    if (lineup.length !== sportCfg.slots.length) continue;

    // NFL stack validation
    if (sportCfg.stack?.needQBStack) {
      const qb = lineup.find(p=>p.pos==="QB");
      const recs = lineup.filter(p=>(p.pos==="WR"||p.pos==="TE") && p.team===qb.team);
      if (!qb || recs.length < sportCfg.stack.minReceivers) continue;
    }

    // Score
    const totalProj = fmt(lineup.reduce((s,p)=>s+(p.projAdj||p.proj||0),0));
    const candidate = { usedSalary: used, totalProj, lineup: lineup.map(({projAdj, ...rest})=>rest) };
    if (!best || candidate.totalProj > best.totalProj || (candidate.totalProj===best.totalProj && candidate.usedSalary<best.usedSalary)) {
      best = candidate;
    }
  }

  return best;
}

function generateLineups(players, sportCfg, {
  salaryCap,
  count=20,
  noise=1.2,
  temperature=0.6,
  maxPerTeam,
  minDiff=4,        // minimum symmetric difference vs. any kept lineup
  triesPerLineup=300
} = {}){
  const out=[]; const seen=new Set();

  while (out.length < count) {
    const cand = buildLineup(players, sportCfg, {
      salaryCap,
      noise,
      temperature,
      maxPerTeam,
      minTries: triesPerLineup
    });
    if (!cand || !cand.lineup) break;

    // uniqueness gate
    let unique = true;
    for (const L of out) {
      if (hamming(L.lineup, cand.lineup) < minDiff) { unique = false; break; }
    }
    const key = uniqKey(cand.lineup);
    if (seen.has(key)) unique = false;

    if (unique) { out.push(cand); seen.add(key); }
    else {
      // small tweak to search space if duplicate-ish
      noise = noise * 1.01;
      temperature = temperature * 1.02;
    }
    if (out.length >= count) break;
    if (out.length === 0 && noise < 2.5) { noise += 0.05; } // expand search for tough slates
  }

  // Order: best projection, then lower salary
  out.sort((a,b)=> (b.totalProj - a.totalProj) || (a.usedSalary - b.usedSalary));
  return out;
}

// ---------- Routes ----------
app.get("/", (_req,res)=> res.redirect("/api/health"));

app.get("/api/health", (_req,res)=>{
  res.json({
    ok:true,
    players: PLAYERS.length,
    lastRefresh: LAST_REFRESH,
    source: LAST_SOURCE,
    sport: CURRENT_SPORT,
    time: new Date().toISOString()
  });
});

app.get("/api/players", async (_req,res)=>{
  try{ await ensureFresh(); res.json({ players: PLAYERS, sport: CURRENT_SPORT }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// Multi-lineup (SPORT-AWARE)
app.post("/api/lineups/optimize", async (req,res)=>{
  try{ await ensureFresh(); }catch{}
  const body = req.body || {};
  const constraints = body.constraints || {};

  // Allow forcing sport from the request; otherwise use current.
  const sport = (constraints.sport || CURRENT_SPORT || "NFL").toUpperCase();
  const roster = ROSTERS[sport] || ROSTERS.NFL;

  const cap         = Number(constraints.salaryCap ?? roster.cap);
  const count       = Number(constraints.numLineups ?? body.count ?? 1);
  const noise       = Number(constraints.noise ?? 1.2);
  const temperature = Number(constraints.temperature ?? 0.6);
  const maxPerTeam  = Number(constraints.maxPerTeam ?? roster.defaultMaxPerTeam);
  const minDiff     = Number(constraints.minDiff ?? (sport === "NFL" ? 4 : 3));
  const triesPer    = Number(constraints.triesPerLineup ?? 300);

  const pool = PLAYERS.filter(p => (p.sport || CURRENT_SPORT) === sport);
  if (!pool.length) return res.json({ salaryCap: cap, count: 0, lineups: [], sport, error: "No players loaded for this sport" });

  if (count <= 1){
    const one = buildLineup(pool, roster, { salaryCap: cap, noise, temperature, maxPerTeam, minTries: triesPer });
    return res.json(one || { error:"Could not build a lineup. Check player pool/constraints." });
  }
  const many = generateLineups(pool, roster, { salaryCap: cap, count, noise, temperature, maxPerTeam, minDiff, triesPerLineup: triesPer });
  res.json({ salaryCap: cap, count: many.length, lineups: many, sport });
});

// Legacy single (kept for compatibility)
app.post("/api/optimize", async (req,res)=>{
  try{ await ensureFresh(); }catch{}
  const cap = Number(req.body?.salaryCap ?? ROSTERS[CURRENT_SPORT]?.cap ?? 50000);
  const roster = ROSTERS[CURRENT_SPORT] || ROSTERS.NFL;
  const pool = PLAYERS.filter(p => (p.sport || CURRENT_SPORT) === CURRENT_SPORT);
  if (!pool.length) return res.json({ error:"No players loaded" });
  const one = buildLineup(pool, roster, { salaryCap: cap, noise: 1.0, temperature: 0.6, maxPerTeam: roster.defaultMaxPerTeam, minTries: 300 });
  res.json(one || { error:"Could not build a lineup. Check player pool." });
});

// Admin: refresh nflverse (NFL only)
app.post("/api/admin/refresh", async (req,res)=>{
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error:"Unauthorized" });
  try{
    const info = await refreshNflverse();
    res.json({ ok:true, ...info });
  }catch(e){
    res.status(500).json({ error:String(e.message||e) });
  }
});

// Admin: DK loader (CSV or URL) — auto-detect sport
app.post("/api/admin/dk", async (req,res)=>{
  const token = req.headers["x-admin-token"] || "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error:"Unauthorized" });

  const rawCsv = trim(req.body?.csv || "");
  const url    = trim(req.body?.url || "");

  try{
    if (rawCsv) {
      const { players, sport } = parseDKCsvToPlayers(rawCsv);
      if (!players.length) throw new Error("No players in CSV");
      PLAYERS = players;
      CURRENT_SPORT = sport;
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = "draftkings";
      return res.json({ ok:true, count: PLAYERS.length, source: LAST_SOURCE, sport: CURRENT_SPORT });
    }
    if (url) {
      const info = await loadDKFromUrl(url);
      return res.json(info);
    }
    return res.status(400).json({ error:"Provide either { csv } or { url }" });
  }catch(e){
    res.status(500).json({ error:String(e.message||e) });
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", ()=>{
  console.log(`Fantasy backend running on port ${PORT}`);
});
