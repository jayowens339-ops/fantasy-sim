// backend/server.js
// Real NFL names (nflverse) + weighted PPR projections + rules-aware optimizer
// NEW: multi-lineup generation (count), diversified by stacks & slight randomness.

const express = require("express");
const cors = require("cors");
const Papa = require("papaparse");

const app = express();
const PORT = process.env.PORT || 5000;

// ----- Config -----
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "Truetrenddfs4u!";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const REFRESH_MS  = 6 * 60 * 60 * 1000; // auto refresh every 6h

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// ----- In-memory state -----
let PLAYERS = [];                // {id,name,team,pos,proj,salary}
let LAST_REFRESH = null;
let LAST_SOURCE  = null;

// ----- Fallback mini sample (safety only) -----
const SAMPLE = [
  { id:"QB1",  name:"J. Elite",      team:"NE",  pos:"QB",  salary:7200, proj:22.5 },
  { id:"RB1",  name:"R. Thunder",    team:"SF",  pos:"RB",  salary:6900, proj:18.0 },
  { id:"WR1",  name:"W. Alpha",      team:"MIN", pos:"WR",  salary:8200, proj:21.0 },
  { id:"TE1",  name:"T. Titan",      team:"KC",  pos:"TE",  salary:7300, proj:17.8 },
  { id:"DST1", name:"Steel Wall",    team:"PIT", pos:"DST", salary:3300, proj: 7.0 }
];

// ----- nflverse sources -----
const NOW_YEAR = new Date().getFullYear();
const TRY_SEASONS = [NOW_YEAR, NOW_YEAR - 1];

const playerWeekUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${season}.csv`;
const teamWeekUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/team_stats/stats_team_week_${season}.csv`;

// ----- Utilities -----
const n = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const rnd = (min, max) => min + Math.random() * (max - min);

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
  pts += passY * 0.04; pts += passT * 4; pts -= ints * 1;
  pts += rushY * 0.1;  pts += rushT * 6;
  pts += rec * 1;      pts += recY * 0.1; pts += recT * 6;
  pts -= fumL * 2;
  return pts;
}

function weightedProj(points){
  if (!points.length) return 0;
  const last = points.slice(-3);
  if (last.length === 1) return Number(last[0].toFixed(2));
  if (last.length === 2) return Number((last[1]*0.3 + last[0]*0.7).toFixed(2));
  return Number((last[2]*0.2 + last[1]*0.3 + last[0]*0.5).toFixed(2));
}

function seasonAvg(points){
  if (!points.length) return 0;
  return Number((points.reduce((a,b)=>a+b,0)/points.length).toFixed(2));
}

// Position-based salary curves (simple but realistic slope + caps)
function salaryFor(pos, proj){
  const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
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

// Build offense (QB/RB/WR/TE) from player-week CSV rows
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

    out.push({ id:pid, name, team: team||"FA", pos, proj, salary: salaryFor(pos, proj) });
  }
  return out;
}

// Build D/ST from team-week CSV with classic DST scoring
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
    out.push({ id:`DST_${team}`, name:`${team} D/ST`, team, pos:"DST", proj, salary: salaryFor("DST", proj) });
  }
  return out;
}

// Fetch & build all players (offense + DST)
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
  return { players: all, count: all.length };
}

async function refreshPlayers(){
  const tries=[];
  for(const season of TRY_SEASONS){
    try{
      const { players, count } = await fetchSeason(season);
      if(!count){ tries.push(`${season}: 0 players`); continue; }
      PLAYERS = players;
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = `nflverse ${season}`;
      return { ok:true, season, count };
    }catch(e){ tries.push(`${season}: ${e.message}`); }
  }
  throw new Error(tries.join(" | "));
}

async function ensureFresh(){
  if(!PLAYERS.length){
    try{ await refreshPlayers(); }
    catch{
      PLAYERS=[...SAMPLE]; LAST_REFRESH=new Date().toISOString(); LAST_SOURCE="fallback:sample";
    }
    return;
  }
  if(Date.now()-Date.parse(LAST_REFRESH) > REFRESH_MS){
    try{ await refreshPlayers(); } catch {/* keep old */}
  }
}
setInterval(()=>{ ensureFresh().catch(()=>{}); }, 30*60*1000);
ensureFresh().catch(()=>{});

// ---------- Rules-aware optimizer (single lineup) ----------
function optimizeWithRules(players, salaryCap=50000, noise=0){
  const roster = { QB:1, RB:2, WR:3, TE:1, FLEX:1, DST:1 };

  // add slight randomness to diversify if noise>0
  const noisy = players.map(p => ({
    ...p,
    projAdj: p.proj + (noise ? rnd(-noise, noise) : 0)
  }));

  const byPos = { QB:[], RB:[], WR:[], TE:[], DST:[] };
  for(const p of noisy) if (byPos[p.pos]) byPos[p.pos].push(p);
  for(const k of Object.keys(byPos)){
    byPos[k].sort((a,b)=>{
      const va=(a.projAdj||0)/Math.max(1,a.salary||1);
      const vb=(b.projAdj||0)/Math.max(1,b.salary||1);
      if(vb!==va) return vb-va;
      return (b.projAdj||0)-(a.projAdj||0);
    });
  }

  const qbList = byPos.QB.slice(0,12);
  let best=null;

  for(const qb of qbList){
    const sameTeamWRTE = [...byPos.WR, ...byPos.TE].filter(x=>x.team===qb.team);

    if (!sameTeamWRTE.length) continue;

    // Build candidate stacks (1- and 2-player)
    const stackCombos = [];
    sameTeamWRTE.slice(0,6).forEach(a => stackCombos.push([a]));
    for(const a of sameTeamWRTE.slice(0,4)){
      for(const b of sameTeamWRTE.slice(0,6)){
        if (a.id!==b.id) stackCombos.push([a,b]);
      }
    }

    for(const stack of stackCombos){
      const taken = new Set([qb.id, ...stack.map(s=>s.id)]);
      let lineup = [qb, ...stack];
      let used   = lineup.reduce((s,p)=>s+p.salary,0);

      if (used > salaryCap) continue;

      // pick DST (avoid same-team offense)
      const dstPick = byPos.DST.find(d => !lineup.some(o => o.team===d.team));
      if (!dstPick || used + dstPick.salary > salaryCap) continue;
      lineup.push(dstPick); taken.add(dstPick.id); used += dstPick.salary;

      const need = { QB:1, RB:2, WR:3, TE:1, FLEX:1, DST:1 };
      need.QB -= 1; need.DST -= 1; for (const s of stack) need[s.pos] -= 1;

      function addBest(posList, count){
        for(const p of posList){
          if (!count) break;
          if (taken.has(p.id)) continue;
          if (p.team === dstPick.team) continue;
          if (used + p.salary > salaryCap) continue;
          lineup.push(p); taken.add(p.id); used += p.salary; count--;
        }
        return count;
      }

      let rbNeed = need.RB, wrNeed = need.WR, teNeed = need.TE;
      rbNeed = addBest(byPos.RB, rbNeed);
      wrNeed = addBest(byPos.WR, wrNeed);
      teNeed = addBest(byPos.TE, teNeed);
      if (rbNeed>0 || wrNeed>0 || teNeed>0) continue;

      // FLEX
      const flexPool = [...byPos.RB, ...byPos.WR, ...byPos.TE]
        .filter(p => !taken.has(p.id) && p.team !== dstPick.team);
      for(const p of flexPool){
        if (!need.FLEX) break;
        if (used + p.salary > salaryCap) continue;
        lineup.push(p); taken.add(p.id); used += p.salary; need.FLEX--;
      }
      if (lineup.length !== 9) continue;

      const proj = Number(lineup.reduce((s,p)=>s+(p.projAdj||p.proj||0),0).toFixed(2));
      const candidate = { salaryCap, usedSalary: used, totalProj: proj, lineup: lineup.map(({projAdj, ...rest})=>rest) };
      if (!best || candidate.totalProj > best.totalProj) best = candidate;
    }
  }

  // If nothing built, quick greedy fallback
  if (!best) {
    const sorted = [...noisy].sort((a,b)=>{
      const va=(a.projAdj||0)/Math.max(1,a.salary||1);
      const vb=(b.projAdj||0)/Math.max(1,b.salary||1);
      if(vb!==va) return vb-va;
      return (b.projAdj||0)-(a.projAdj||0);
    });
    const taken=new Set(); let used=0; const lineup=[];
    function add(p){ if(taken.has(p.id)||used+p.salary>salaryCap) return false; lineup.push(p); taken.add(p.id); used+=p.salary; return true; }
    // Fill rough roster
    const order=["QB","RB","RB","WR","WR","WR","TE","DST"];
    for(const pos of order){
      const pick = sorted.find(x => x.pos===pos && !taken.has(x.id));
      if (pick) add(pick);
    }
    // FLEX
    const flexPick = sorted.find(x => ["RB","WR","TE"].includes(x.pos) && !taken.has(x.id));
    if (flexPick) add(flexPick);
    const proj = Number(lineup.reduce((s,p)=>s+(p.projAdj||p.proj||0),0).toFixed(2));
    best = { salaryCap, usedSalary: used, totalProj: proj, lineup: lineup.map(({projAdj, ...rest})=>rest) };
  }
  return best;
}

// ---------- Multi-lineup generator ----------
function uniqueKey(lineup){
  return lineup.map(p=>p.id).sort().join("|");
}

function generateLineups(players, { salaryCap=50000, count=20, noise=1.2 } = {}){
  const lineups = [];
  const seen = new Set();
  const qbTeams = Array.from(new Set(players.filter(p=>p.pos==="QB").map(q=>q.team)));

  // Try cycles with varying noise & different QB teams to diversify
  let tries = 0, maxTries = count * 12;
  while (lineups.length < count && tries < maxTries) {
    tries++;
    const n = noise * (0.6 + Math.random()*0.8); // vary noise a bit per try
    const res = optimizeWithRules(players, salaryCap, n);
    if (!res || !res.lineup || res.lineup.length !== 9) continue;

    // enforce uniqueness by player set
    const key = uniqueKey(res.lineup);
    if (seen.has(key)) continue;

    seen.add(key);
    lineups.push(res);
  }

  // sort best first
  lineups.sort((a,b)=> (b.totalProj - a.totalProj) || (a.usedSalary - b.usedSalary));
  return lineups;
}

// ---------- Routes ----------
app.get("/", (req,res)=>res.redirect("/api/health"));

app.get("/api/health", (_req,res)=>{
  res.json({ ok:true, players: PLAYERS.length, lastRefresh: LAST_REFRESH, source: LAST_SOURCE, time: new Date().toISOString() });
});

app.get("/api/players", async (_req,res)=>{
  try{ await ensureFresh(); res.json({ players: PLAYERS }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// NEW: support multiple lineups via `count` or `constraints.numLineups`
app.post("/api/lineups/optimize", async (req,res)=>{
  try{ await ensureFresh(); }catch{}
  const cap = Number(req.body?.constraints?.salaryCap ?? 50000);
  const count = Number(req.body?.constraints?.numLineups ?? req.body?.count ?? 1);
  const noise = Number(req.body?.constraints?.noise ?? 1.2); // 0=none, 0.5=low, 1–2 typical

  if (count <= 1) {
    const one = optimizeWithRules(PLAYERS, cap, noise);
    return res.json(one);
  }
  const many = generateLineups(PLAYERS, { salaryCap: cap, count, noise });
  return res.json({ salaryCap: cap, count: many.length, lineups: many });
});

// Legacy single-lineup endpoint (still works)
app.post("/api/optimize", async (req,res)=>{
  try{ await ensureFresh(); }catch{}
  const cap = Number(req.body?.salaryCap ?? 50000);
  const one = optimizeWithRules(PLAYERS, cap, 1.0);
  res.json(one);
});

// Admin: force refresh
app.post("/api/admin/refresh", async (req,res)=>{
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error:"Unauthorized" });
  try{ const info = await refreshPlayers(); res.json({ ok:true, ...info }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

// ---------- Data refresh helpers ----------
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
  return { players: all, count: all.length };
}

async function refreshPlayers(){
  const tries=[];
  for(const season of TRY_SEASONS){
    try{
      const { players, count } = await fetchSeason(season);
      if(!count){ tries.push(`${season}: 0 players`); continue; }
      PLAYERS = players;
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE  = `nflverse ${season}`;
      return { ok:true, season, count };
    }catch(e){ tries.push(`${season}: ${e.message}`); }
  }
  throw new Error(tries.join(" | "));
}

async function ensureFresh(){
  if(!PLAYERS.length){
    try{ await refreshPlayers(); }
    catch{
      PLAYERS=[...SAMPLE]; LAST_REFRESH=new Date().toISOString(); LAST_SOURCE="fallback:sample";
    }
    return;
  }
  if(Date.now()-Date.parse(LAST_REFRESH) > REFRESH_MS){
    try{ await refreshPlayers(); } catch {/* keep old */}
  }
}

// ---------- Boot ----------
app.listen(PORT, "0.0.0.0", ()=>{
  console.log(`Fantasy backend running on port ${PORT}`);
});
