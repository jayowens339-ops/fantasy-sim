// backend/server.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 5000;

// CORS
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

// --- Guaranteed fallback players (will show instantly) ---
const SAMPLE = [
  { id:"QB1",  name:"J. Elite",      team:"NE",  pos:"QB",  salary:7200, proj:22.5 },
  { id:"QB2",  name:"K. Gunslinger", team:"KC",  pos:"QB",  salary:7600, proj:23.1 },
  { id:"RB1",  name:"R. Thunder",    team:"SF",  pos:"RB",  salary:6900, proj:18.0 },
  { id:"RB2",  name:"B. Workhorse",  team:"DAL", pos:"RB",  salary:6800, proj:16.9 },
  { id:"RB3",  name:"S. ValueBack",  team:"CHI", pos:"RB",  salary:5200, proj:14.2 },
  { id:"WR1",  name:"W. Alpha",      team:"MIN", pos:"WR",  salary:8200, proj:21.0 },
  { id:"WR2",  name:"C. DeepThreat", team:"MIA", pos:"WR",  salary:7000, proj:17.2 },
  { id:"WR3",  name:"R. Slot",       team:"LAR", pos:"WR",  salary:5400, proj:12.8 },
  { id:"WR4",  name:"T. Rookie",     team:"HOU", pos:"WR",  salary:4800, proj:11.3 },
  { id:"TE1",  name:"T. Titan",      team:"KC",  pos:"TE",  salary:7300, proj:17.8 },
  { id:"TE2",  name:"M. MidTier",    team:"DET", pos:"TE",  salary:4500, proj:9.4 },
  { id:"DST1", name:"Steel Wall",    team:"PIT", pos:"DST", salary:3300, proj:7.0 },
  { id:"DST2", name:"Windy D",       team:"CHI", pos:"DST", salary:2800, proj:6.1 }
];

// In-memory players (start with SAMPLE so UI works)
let PLAYERS = [...SAMPLE];

// Optional: background fetch of live data (best-effort; ignored if it fails)
async function tryRefreshLive() {
  try {
    // Example: pull a public demo JSON you control later, or keep SAMPLE.
    // For now we just keep SAMPLE to guarantee stability.
    // If you add a real feed, parse it and assign PLAYERS = parsed;
    // e.g., const res = await fetch('https://your-public-json/players.json');
    // const data = await res.json(); PLAYERS = data.players || data;
  } catch { /* ignore errors */ }
}
tryRefreshLive();
setInterval(tryRefreshLive, 60 * 60 * 1000); // check hourly

// --- Health
app.get("/api/health", (_req, res) => {
  res.json({ ok:true, players: PLAYERS.length, time: new Date().toISOString() });
});

// --- Players
app.get("/api/players", (_req, res) => {
  res.json({ players: PLAYERS });
});

// --- Optimizer (value-based greedy) ---
function optimize(players, salaryCap = 50000) {
  const sorted = [...players].sort((a,b)=>{
    const va=(a.proj||0)/Math.max(1,a.salary||1);
    const vb=(b.proj||0)/Math.max(1,b.salary||1);
    if (vb!==va) return vb-va;
    return (b.proj||0)-(a.proj||0);
  });
  const roster = { QB:1, RB:2, WR:3, TE:1, FLEX:1, DST:1 };
  const flexFrom = ["RB","WR","TE"];

  let lineup=[], used=0;
  const taken = new Set();
  const add = p => { if (taken.has(p.id) || used + p.salary > salaryCap) return false;
    taken.add(p.id); lineup.push(p); used += p.salary; return true; };

  // strict positions
  for (const [pos, need] of Object.entries(roster)) {
    if (pos === "FLEX") continue;
    let left = need;
    for (const p of sorted) if (left && p.pos === pos) left -= add(p) ? 1 : 0;
  }
  // FLEX
  let flex = roster.FLEX || 0;
  for (const p of sorted) if (flex && flexFrom.includes(p.pos)) flex -= add(p) ? 1 : 0;

  const totalProj = Number(lineup.reduce((s,p)=>s+(p.proj||0),0).toFixed(2));
  return { salaryCap, usedSalary: used, totalProj, lineup };
}

// Support both endpoints your UIs used
app.post("/api/lineups/optimize", (req, res) => {
  const cap = Number(req.body?.constraints?.salaryCap ?? 50000);
  res.json(optimize(PLAYERS, cap));
});
app.post("/api/optimize", (req, res) => {
  const cap = Number(req.body?.salaryCap ?? 50000);
  res.json(optimize(PLAYERS, cap));
});

// Start
app.listen(PORT, () => {
  console.log(`Fantasy backend running on port ${PORT}`);
});
