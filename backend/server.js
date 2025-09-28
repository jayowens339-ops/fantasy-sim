// backend/server.js
// Fantasy Sim backend — DK CSV upload/URL + nflverse fallback + multi-lineup optimizer

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
app.use(express.json({ limit: "15mb" })); // allow big CSVs when sent as text in JSON

// ---------- State ----------
let PLAYERS = []; // array of {id, name, team, pos, proj, salary}
let LAST_REFRESH = null;
let LAST_SOURCE  = null;

// ---------- Helpers ----------
const n = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const trim = (s) => (s || "").toString().trim();
const rnd = (min, max) => min + Math.random() * (max - min);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function fmtNum(x, d = 2) { return Number((x ?? 0).toFixed(d)); }

// ---------- DraftKings CSV parsing ----------
function parseDKCsvToPlayers(csvText){
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const rows = parsed.data || [];
  const players = [];

  for(const r of rows){
    const posRaw = trim(r.Position || r["Roster Position"] || r["Roster Positions"] || r["RosterPosition"]);
    const pos = posRaw.split(/[\/,]/)[0].toUpperCase(); // first eligible pos
    const id = trim(r.ID || r["Player ID"] || r["DraftKings ID"] || r["ID"]);
    const name = trim(r.Name || r["Player Name"] || "");
    const team = trim(r.TeamAbbrev || r.Team || r["Team Abbrev"] || "");
    const salary = n(r.Salary || r["DK Salary"] || r["Salary (DK)"]);
    const proj = n(r.AvgPointsPerGame || r["Avg Points/GM"] || r.Projection || r.Proj || r.FPPG);

    if(!name || !pos || !salary) continue;
    const display = pos === "DST" ? `${team || name} D/ST` : name;

    players.push({
      id: id || `${name}_${team}_${pos}`,
      name: display,
      team: team.toUpperCase(),
      pos,
      salary,
      proj
    });
  }

  // de-dupe best projection per id
  const map = new Map();
  for(const p of players){
    if(!map.has(p.id) || (p.proj||0) > (map.get(p.id).proj||0)) map.set(p.id, p);
  }
  return Array.from(map.values());
}

async function loadDKFromUrl(url){
  const resp = await fetch(url, { headers: { "User-Agent": "fantasy-sim/1.0" }});
  if(!resp.ok) throw new Error(`DK CSV fetch failed: HTTP ${resp.status}`);
  const csvText = await resp.text();
  const players = parseDKCsvToPlayers(csvText);
  if(!players.length) throw new Error("No players in DK CSV (or unexpected headers)");
  PLAYERS = players;
  LAST_REFRESH = new Date().toISOString();
  LAST_SOURCE = "draftkings";
  return { ok: true, count: PLAYERS.length, source: LAST_SOURCE };
}

// ---------- nflverse fallback ----------
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
  if(!points.length) return 0;
  const last = points.slice(-3);
  if(last.length === 1) return fmtNum(last[0]);
  if(last.length === 2) return fmtNum(last[1]*0.3 + last[0]*0.7);
  return fmtNum(last[2]*0.2 + last[1]*0.3 + last[0]*0.5);
}
function seasonAvg(points){
  if(!points.length) return 0;
  return fmtNum(points.reduce((a,b)=>a+b,0)/points.length);
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
    const pos = (r.position || r.pos || "").toUpperCase();
    if(!["QB","RB","WR","TE"].includes(pos)) continue;
    const pid = r.player_id || r.gsis_id || r.pfr_player_id || r.pfr_id ||
                `${r.player_name}_${pos}_${r.recent_team || r.team}`;
    if(!byId.has(pid)) byId.set(pid, []);
    byId.get(pid).push(r);
  }
  const out = [];
  for(const [pid, list] of byId.entries()){
    list.sort((a,b)=> n(a.week)-n(b.week));
    const pts = list.map(pprRow);
    let proj = weightedProj(pts);
    if(proj === 0) proj = seasonAvg(pts);
    const latest = list[list.length-1];
    const name = latest.player_name || latest.name || latest.player || "Unknown";
    const team = (latest.recent_team || latest.team || latest.posteam || "").toUpperCase();
    const pos  = (latest.position || latest.pos || "").toUpperCase();
    if(!name || !pos) continue;
    out.push({ id:pid, name, team: team || "FA", pos, proj, salary: salaryFromProj(pos, proj) });
  }
  return out;
}
function buildDST(rows){
  const byTeam = new Map();
  for(const r of rows){
    const team = (r.team || r.recent_team || r.posteam || r.defteam || "").toUpperCase();
    if(!team || team.length>3) continue;
    if(!byTeam.has(team)) byTeam.set(team, []);
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
  const out = [];
  for(const [team, list] of byTeam.entries()){
    list.sort((a,b)=> n(a.week)-n(b.week));
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
    if(proj === 0) proj = seasonAvg(pts);
    out.push({ id:`DST_${team}`, name:`${team} D/ST`, team, pos:"DST", proj, salary: salaryFromProj("DST", proj) });
  }
  return out;
}
async function fetchSeason(season){
  const [pRes, tRes] = await Promise.all([
    fetch(playerWeekUrl(season), { headers: { "User-Agent":"fantasy-sim/1.0" } }),
    fetch(teamWeekUrl(season),   { headers: { "User-Agent":"fantasy-sim/1.0" } })
  ]);
  if(!pRes.ok) throw new Error(`players ${season}: HTTP ${pRes.status}`);
  if(!tRes.ok) throw new Error(`teams ${season}: HTTP ${tRes.status}`);
  const [pText, tText] = await Promise.all([pRes.text(), tRes.text()]);
  const pParsed = Papa.parse(pText, { header:true, skipEmptyLines:true });
  const tParsed = Papa.parse(tText, { header:true, skipEmptyLines:true });
  const offense = buildOffense(pParsed.data || []);
  const dst     = buildDST(tParsed.data || []);
  const all     = [...offense, ...dst].filter(p=>p.name && p.pos);
  return { players: all, count: all.length, source: `nflverse ${season}` };
}
async function refreshNflverse(){
  const tries = [];
  for(const s of TRY_SEASONS){
    try{
      const { players, count, source } = await fetchSeason(s);
      if(!count){ tries.push(`${s}: 0 players`); continue; }
      PLAYERS = players;
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = source;
      return { ok:true, season:s, count, source };
    }catch(e){ tries.push(`${s}: ${e.message}`); }
  }
  throw new Error(tries.join(" | "));
}

// ---------- Auto ensure data ----------
async function ensureFresh(){
  if(!PLAYERS.length){
    try{
      if(DK_SALARIES_URL) await loadDKFromUrl(DK_SALARIES_URL);
      else await refreshNflverse();
    }catch(e){
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE = "empty";
    }
    return;
  }
  if(Date.now() - Date.parse(LAST_REFRESH || 0) > REFRESH_MS){
    try{
      if(LAST_SOURCE === "draftkings" && DK_SALARIES_URL) await loadDKFromUrl(DK_SALARIES_URL);
      else await refreshNflverse();
    }catch{/* keep old */}
  }
}
setInterval(()=>{ ensureFresh().catch(()=>{}); }, 30*60*1000);
ensureFresh().catch(()=>{});

// ---------- Optimizer ----------
function optimizeWithRules(players, salaryCap=50000, noise=0){
  const noisy = players.map(p => ({ ...p, projAdj: p.proj + (noise ? rnd(-noise, noise) : 0) }));
  const byPos = { QB:[], RB:[], WR:[], TE:[], DST:[] };
  for(const p of noisy) if(byPos[p.pos]) byPos[p.pos].push(p);

  for(const k of Object.keys(byPos)){
    byPos[k].sort((a,b)=>{
      const va=(a.projAdj||0)/Math.max(1,a.salary||1);
      const vb=(b.projAdj||0)/Math.max(1,b.salary||1);
      if(vb!==va) return vb-va;
      return (b.projAdj||0)-(a.projAdj||0);
    });
  }

  const qbList = byPos.QB.slice(0,15);
  let best = null;

  for(const qb of qbList){
    const sameTeamREC = [...(byPos.WR||[]), ...(byPos.TE||[])].filter(x=>x.team===qb.team);
    if(!sameTeamREC.length) continue;

    const stacks=[];
    sameTeamREC.slice(0,6).forEach(a => stacks.push([a]));
    for(const a of sameTeamREC.slice(0,4)){
      for(const b of sameTeamREC.slice(0,6)){
        if(a.id!==b.id) stacks.push([a,b]);
      }
    }

    for(const stack of stacks){
      const taken = new Set([qb.id, ...stack.map(s=>s.id)]);
      let lineup = [qb, ...stack];
      let used   = lineup.reduce((s,p)=>s+p.salary,0);
      if(used > salaryCap) continue;

      const dst = (byPos.DST||[]).find(d => !lineup.some(o => o.team === d.team));
      if(!dst || used + dst.salary > salaryCap) continue;
      lineup.push(dst); taken.add(dst.id); used += dst.salary;

      const need = { QB:1, RB:2, WR:3, TE:1, FLEX:1, DST:1 };
      need.QB-=1; need.DST-=1; for(const s of stack) need[s.pos]-=1;

      function addBest(list, count){
        for(const p of list){
          if(!count) break;
          if(taken.has(p.id)) continue;
          if(p.team === dst.team) continue;
          if(used + p.salary > salaryCap) continue;
          lineup.push(p); taken.add(p.id); used += p.salary; count--;
        }
        return count;
      }

      let rbNeed=need.RB, wrNeed=need.WR, teNeed=need.TE;
      rbNeed = addBest(byPos.RB||[], rbNeed);
      wrNeed = addBest(byPos.WR||[], wrNeed);
      teNeed = addBest(byPos.TE||[], teNeed);
      if(rbNeed>0 || wrNeed>0 || teNeed>0) continue;

      const flexPool = [...(byPos.RB||[]), ...(byPos.WR||[]), ...(byPos.TE||[])]
        .filter(p => !taken.has(p.id) && p.team !== dst.team);
      for(const p of flexPool){
        if(!need.FLEX) break;
        if(used + p.salary > salaryCap) continue;
        lineup.push(p); taken.add(p.id); used += p.salary; need.FLEX--;
      }
      if(lineup.length !== 9) continue;

      const proj = fmtNum(lineup.reduce((s,p)=>s+(p.projAdj||p.proj||0),0));
      const candidate = {
        salaryCap,
        usedSalary: used,
        totalProj: proj,
        lineup: lineup.map(({projAdj, ...rest})=>rest)
      };
      if(!best || candidate.totalProj > best.totalProj) best = candidate;
    }
  }
  return best;
}
function uniqueKey(lineup){ return lineup.map(p=>p.id).sort().join("|"); }
function generateLineups(players, { salaryCap=50000, count=20, noise=1.2 } = {}){
  const out=[]; const seen=new Set();
  let tries=0, maxTries=count*12;
  while(out.length<count && tries<maxTries){
    tries++;
    const nsz = noise*(0.6+Math.random()*0.8);
    const res = optimizeWithRules(players, salaryCap, nsz);
    if(!res || !res.lineup || res.lineup.length!==9) continue;
    const key = uniqueKey(res.lineup);
    if(seen.has(key)) continue;
    seen.add(key); out.push(res);
  }
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
    time: new Date().toISOString()
  });
});

app.get("/api/players", async (_req,res)=>{
  try{ await ensureFresh(); res.json({ players: PLAYERS }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// multi-lineup
app.post("/api/lineups/optimize", async (req,res)=>{
  try{ await ensureFresh(); }catch{}
  const cap   = Number(req.body?.constraints?.salaryCap ?? 50000);
  const count = Number(req.body?.constraints?.numLineups ?? req.body?.count ?? 1);
  const noise = Number(req.body?.constraints?.noise ?? 1.2);

  if(!PLAYERS.length) return res.json({ lineups: [], salaryCap: cap, error: "No players loaded" });

  if(count <= 1){
    const one = optimizeWithRules(PLAYERS, cap, noise);
    return res.json(one || { error:"Could not build a lineup. Check player pool." });
  }
  const many = generateLineups(PLAYERS, { salaryCap: cap, count, noise });
  res.json({ salaryCap: cap, count: many.length, lineups: many });
});

// legacy single
app.post("/api/optimize", async (req,res)=>{
  try{ await ensureFresh(); }catch{}
  const cap = Number(req.body?.salaryCap ?? 50000);
  if(!PLAYERS.length) return res.json({ error:"No players loaded" });
  const one = optimizeWithRules(PLAYERS, cap, 1.0);
  res.json(one || { error:"Could not build a lineup. Check player pool." });
});

// admin: refresh nflverse
app.post("/api/admin/refresh", async (req,res)=>{
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if(token !== ADMIN_TOKEN) return res.status(401).json({ error:"Unauthorized" });
  try{
    const info = await refreshNflverse();
    res.json({ ok:true, ...info });
  }catch(e){
    res.status(500).json({ error:String(e.message||e) });
  }
});

// admin: DK loader (CSV OR URL)
app.post("/api/admin/dk", async (req,res)=>{
  const token = req.headers["x-admin-token"] || "";
  if(token !== ADMIN_TOKEN) return res.status(401).json({ error:"Unauthorized" });

  const rawCsv = trim(req.body?.csv || "");
  const url    = trim(req.body?.url || "");

  try{
    if(rawCsv){
      const players = parseDKCsvToPlayers(rawCsv);
      if(!players.length) throw new Error("No players in CSV");
      PLAYERS = players;
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = "draftkings";
      return res.json({ ok:true, count: PLAYERS.length, source: LAST_SOURCE });
    }
    if(url){
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
