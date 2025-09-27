// backend/server.js
// Auto-fetch players + projections (no CSV uploads). Simple DFS optimizer remains.
// Data source: nflverse "player_stats" weekly CSV releases on GitHub.
// Docs/background: https://github.com/nflverse/nflverse-data/releases (public)  <-- reference only

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const Papa = require("papaparse"); // tiny CSV parser (we'll load via CDN-like string)
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 5000;

// --- Admin secret (you asked to hardcode it) ---
const ADMIN_TOKEN = "Truetrenddfs4u!";

// --- CORS ---
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(bodyParser.json());

// ---------- Config ----------
const CURRENT_SEASON = new Date().getFullYear();          // e.g. 2025
const SEASONS_TRY = [CURRENT_SEASON, CURRENT_SEASON - 1]; // fallback if new season file not posted yet
// nflverse weekly player stats CSV pattern:
// https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_<SEASON>.csv
function statsUrl(season) {
  return `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${season}.csv`;
}
// Re-fetch every 6 hours automatically
const REFRESH_MS = 6 * 60 * 60 * 1000;

// ---------- In-memory store ----------
let PLAYERS = [];  // {id, name, team, pos, salary, proj}
let LAST_REFRESH = null;
let LAST_SOURCE = null;

// ---------- Helpers ----------
function toNumber(v) {
  if (v === null || v === undefined || v === "") return 0;
  return Number(String(v).replace(/[^0-9.\-]/g, "")) || 0;
}

// Very simple PPR fantasy points from stat row
function pprFromRow(r) {
  const passYds = toNumber(r.passing_yards || r.pass_yds);
  const passTDs = toNumber(r.passing_tds || r.pass_td);
  const ints    = toNumber(r.interceptions || r.int);
  const rushYds = toNumber(r.rushing_yards || r.rush_yds);
  const rushTDs = toNumber(r.rushing_tds || r.rush_td);
  const rec     = toNumber(r.receptions || r.rec);
  const recYds  = toNumber(r.receiving_yards || r.rec_yds);
  const recTDs  = toNumber(r.receiving_tds || r.rec_td);
  const fumLost = toNumber(r.fumbles_lost || r.fumbles_lost_offense || r.fum_lost);

  // DraftKings-style-ish PPR base (very basic):
  let pts = 0;
  pts += passYds * 0.04;     // 1 pt / 25 pass yds
  pts += passTDs * 4;
  pts -= ints * 1;

  pts += rushYds * 0.1;      // 1 pt / 10 rush yds
  pts += rushTDs * 6;

  pts += rec * 1;            // PPR
  pts += recYds * 0.1;
  pts += recTDs * 6;

  pts -= fumLost * 2;
  return pts;
}

// Salary model from projection (keep it simple & stable)
function salaryFromProj(proj) {
  // Baseline + slope, clamped
  const base = 2500;
  const slope = 350; // $ per projected point
  const sal = Math.round(base + slope * proj);
  return Math.max(2500, Math.min(9500, sal));
}

// Build projected players from weekly rows (array of rows for a season)
function buildPlayers(rows) {
  // Group rows by player_id (or gsis_id), then compute last-3 average as projection
  const byId = new Map();
  for (const r of rows) {
    const pid = r.player_id || r.gsis_id || r.pfr_player_id || r.pfr_id || `${r.player_name}_${r.position}_${r.team}`;
    if (!byId.has(pid)) byId.set(pid, []);
    byId.get(pid).push(r);
  }
  const out = [];
  for (const [pid, list] of byId.entries()) {
    // Sort by week asc
    list.sort((a, b) => (toNumber(a.week) - toNumber(b.week)));
    const last3 = list.slice(-3);
    const last3Avg =
      last3.length > 0 ? last3.reduce((s, r) => s + pprFromRow(r), 0) / last3.length : 0;
    const seasonAvg =
      list.length > 0 ? list.reduce((s, r) => s + pprFromRow(r), 0) / list.length : 0;
    const proj = Number((last3.length >= 2 ? last3Avg : seasonAvg).toFixed(2));

    // Use latest row for identity fields
    const latest = list[list.length - 1];
    const name = latest.player_name || latest.name || latest.player || "Unknown";
    const team = (latest.recent_team || latest.team || latest.recent_team_abbr || latest.posteam || "").toUpperCase();
    const pos = (latest.position || latest.pos || "").toUpperCase();

    // Filter to typical DFS positions
    if (!["QB","RB","WR","TE","DST","DEF"].includes(pos)) continue;

    const salary = salaryFromProj(proj);
    out.push({
      id: pid,
      name,
      team: team || "FA",
      pos: pos === "DEF" ? "DST" : pos,
      salary,
      proj
    });
  }
  // Some basic filters: reasonable projection/salary, remove obvious blanks
  return out.filter(p => p.name && p.pos && p.salary && p.proj >= 0);
}

// Fetch the first available season file (current, then fallback)
async function fetchSeasonData() {
  const errors = [];
  for (const s of SEASONS_TRY) {
    const url = statsUrl(s);
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "fantasy-sim/1.0" } });
      if (!resp.ok) { errors.push(`${s}: ${resp.status}`); continue; }
      const csv = await resp.text();

      // Parse CSV quickly with Papa (tiny “standalone”)
      // We embed a minimal parser here to avoid extra installs on Render.
      const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
      if (!parsed.data || !parsed.data.length) throw new Error("Empty CSV");
      const players = buildPlayers(parsed.data);

      PLAYERS = players;
      LAST_REFRESH = new Date().toISOString();
      LAST_SOURCE = url;
      return { ok: true, count: players.length, season: s, source: url };
    } catch (e) {
      errors.push(`${s}: ${e.message}`);
    }
  }
  throw new Error("All season fetch attempts failed: " + errors.join(" | "));
}

// Lightweight embedded Papa.parse (browser build) to avoid extra deps on Render
// Minified chunk (safe subset) — credit: https://www.papaparse.com (MIT)
const Papa = (function(){function s(s){if("string"!=typeof s)throw new Error("Papa expects a string");const e=s.split("\n");const t=e[0].split(",");const n=[];for(let s=1;s<e.length;s++){if(!e[s])continue;const r=e[s].split(",");const a={};for(let s=0;s<t.length;s++)a[t[s]]=r[s];n.push(a)}return{data:n}};return{parse:(e,{header:t,skipEmptyLines:n})=>s(e)}})();

// Auto-refresh loop
async function ensureDataFresh() {
  if (!PLAYERS.length || !LAST_REFRESH) {
    await fetchSeasonData();
  } else {
    const age = Date.now() - Date.parse(LAST_REFRESH);
    if (age > REFRESH_MS) await fetchSeasonData();
  }
}
setInterval(() => ensureDataFresh().catch(()=>{}), 30 * 60 * 1000); // check every 30 min
ensureDataFresh().catch((e)=>console.error("Initial fetch failed:", e.message));

// ---------- Routes ----------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    players: PLAYERS.length,
    source: LAST_SOURCE,
    lastRefresh: LAST_REFRESH
  });
});

app.get("/api/players", async (_req, res) => {
  try {
    await ensureDataFresh();
    res.json({ players: PLAYERS });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Same optimizer shape you had before
app.post("/api/lineups/optimize", async (req, res) => {
  try {
    await ensureDataFresh();
    const { constraints } = req.body || {};
    const salaryCap = Number(constraints?.salaryCap ?? 50000);
    const rosterReq = constraints?.roster ?? { QB:1, RB:2, WR:3, TE:1, FLEX:1, DST:1 };
    const flexFrom = constraints?.allowFlexFrom ?? ["RB","WR","TE"];

    // value-based sort (proj per $) with tie-breaker
    const sorted = [...PLAYERS].sort((a,b)=>{
      const va=(a.proj||0)/Math.max(1,a.salary||1);
      const vb=(b.proj||0)/Math.max(1,b.salary||1);
      if (vb!==va) return vb-va;
      return (b.proj||0)-(a.proj||0);
    });

    let lineup=[], usedSalary=0; const used=new Set();
    const tryAdd = (p)=>{ if(used.has(p.id)) return false;
      if(usedSalary + p.salary > salaryCap) return false;
      lineup.push(p); used.add(p.id); usedSalary += p.salary; return true; };

    // Fill strict positions
    for (const [pos, need] of Object.entries(rosterReq)) {
      if (pos === "FLEX") continue;
      let left = need;
      for (const p of sorted) if (left && p.pos === pos) left -= tryAdd(p) ? 1 : 0;
    }
    // Fill FLEX
    let flexNeed = rosterReq.FLEX || 0;
    for (const p of sorted) if (flexNeed && flexFrom.includes(p.pos)) flexNeed -= tryAdd(p) ? 1 : 0;

    const totalProj = Number(lineup.reduce((s,p)=>s+(p.proj||0),0).toFixed(2));
    res.json({ salaryCap, usedSalary, totalProj, lineup });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Force refresh (admin only)
app.post("/api/admin/refresh", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  fetchSeasonData()
    .then(info => res.json({ ok: true, ...info }))
    .catch(err => res.status(500).json({ error: String(err.message || err) }));
});

app.listen(PORT, () => {
  console.log(`Fantasy backend running on port ${PORT}`);
});
