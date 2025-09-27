import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();
const app = express();

// Render/Heroku set PORT for you; default to 4000 locally
const PORT = Number(process.env.PORT || 4000);
const SALARY_CAP = Number(process.env.SALARY_CAP || 50000);

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// JSON + CORS
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || "*" }));

// serve the static frontend for local dev (ignored on Render)
app.use("/", express.static(path.join(__dirname, "../frontend")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "development", time: new Date().toISOString() });
});

// sample data endpoints
app.get("/api/players", (req, res) => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data/players.sample.json"), "utf8"));
  res.json({ players: data });
});

app.get("/api/contests", (req, res) => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data/contests.sample.json"), "utf8"));
  res.json({ contests: data });
});

// tiny greedy optimizer (kept inline to avoid extra imports)
function optimizeLineup(players, constraints = {}) {
  const salaryCap = Number(constraints.salaryCap ?? SALARY_CAP);
  const rosterReq = constraints.roster ?? { QB:1, RB:2, WR:3, TE:1, FLEX:1, DST:1 };
  const flexFrom = constraints.allowFlexFrom ?? ["RB","WR","TE"];

  const sorted = [...players].sort((a,b)=>{
    const va=(a.proj||0)/Math.max(1,a.salary||1);
    const vb=(b.proj||0)/Math.max(1,b.salary||1);
    if(vb!==va) return vb-va;
    return (b.proj||0)-(a.proj||0);
  });

  let lineup=[], usedSalary=0; const used=new Set();
  function fill(pos,count){
    for(const p of sorted){
      if(count<=0) break;
      if(used.has(p.id)||p.pos!==pos||usedSalary+p.salary>salaryCap) continue;
      lineup.push(p); used.add(p.id); usedSalary+=p.salary; count--;
    }
  }
  for(const [pos,need] of Object.entries(rosterReq)){ if(pos!=="FLEX") fill(pos,need); }
  let flexNeed=rosterReq.FLEX||0;
  for(const p of sorted){
    if(flexNeed<=0) break;
    if(used.has(p.id)||!flexFrom.includes(p.pos)||usedSalary+p.salary>salaryCap) continue;
    lineup.push(p); used.add(p.id); usedSalary+=p.salary; flexNeed--;
  }
  const totalProj = lineup.reduce((s,p)=>s+(p.proj||0),0);
  return { salaryCap, usedSalary, totalProj: Number(totalProj.toFixed(2)), lineup };
}

app.post("/api/lineups/optimize", (req, res) => {
  const { constraints, players } = req.body || {};
  let pool = players;
  if (!Array.isArray(pool) || pool.length === 0) {
    pool = JSON.parse(fs.readFileSync(path.join(__dirname, "data/players.sample.json"), "utf8"));
  }
  const result = optimizeLineup(pool, constraints || {});
  res.json(result);
});

app.listen(PORT, () => console.log(`Fantasy backend running at http://localhost:${PORT}`));
