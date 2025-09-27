import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import { parse } from "csv-parse/sync";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const SALARY_CAP = Number(process.env.SALARY_CAP || 50000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const RUNTIME_JSON = path.join(DATA_DIR, "players.runtime.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DATA_CSV_URL = process.env.DATA_CSV_URL || "";

// core middleware
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || "*" }));

// (local dev only) serve static frontend
app.use("/", express.static(path.join(__dirname, "../frontend")));

// --- util: read players store (runtime JSON preferred) ---
function readPlayersStore() {
  const runtime = fs.existsSync(RUNTIME_JSON);
  const fp = runtime ? RUNTIME_JSON : path.join(DATA_DIR, "players.sample.json");
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

// --- health ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "development", time: new Date().toISOString() });
});

// --- data endpoints ---
app.get("/api/players", (_req, res) => res.json({ players: readPlayersStore() }));

app.get("/api/contests", (_req, res) => {
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "contests.sample.json"), "utf8"));
  res.json({ contests: data });
});

// --- tiny greedy optimizer ---
function optimizeLineup(players, constraints = {}) {
  const salaryCap = Number(constraints.salaryCap ?? SALARY_CAP);
  const rosterReq = constraints.roster ?? { QB:1, RB:2, WR:3, TE:1, FLEX:1, DST:1 };
  const flexFrom = constraints.allowFlexFrom ?? ["RB","WR","TE"];

  const sorted = [...players].sort((a,b)=>{
    const va=(a.proj||0)/Math.max(1,a.salary||1);
    const vb=(b.proj||0)/Math.max(1,b.salary||1);
    if (vb !== va) return vb - va;
    return (b.proj||0) - (a.proj||0);
  });

  let lineup=[], usedSalary=0; const used=new Set();
  const tryAdd = (p)=>{ if (used.has(p.id)) return false;
    if (usedSalary + (p.salary||0) > salaryCap) return false;
    lineup.push(p); used.add(p.id); usedSalary += (p.salary||0); return true; };

  // fill strict positions
  for (const [pos, need] of Object.entries(rosterReq)) {
    if (pos === "FLEX") continue;
    let left = need;
    for (const p of sorted) if (left && p.pos === pos) left -= tryAdd(p) ? 1 : 0;
  }
  // fill FLEX
  let flexNeed = rosterReq.FLEX || 0;
  for (const p of sorted) if (flexNeed && flexFrom.includes(p.pos)) flexNeed -= tryAdd(p) ? 1 : 0;

  const totalProj = lineup.reduce((s,p)=>s+(p.proj||0),0);
  return {
    salaryCap,
    usedSalary,
    remainingSalary: Math.max(0, salaryCap-usedSalary),
    totalProj: Number(totalProj.toFixed(2)),
    count: lineup.length,
    lineup
  };
}

app.post("/api/lineups/optimize", (req, res) => {
  const { constraints, players } = req.body || {};
  let pool = players;
  if (!Array.isArray(pool) || pool.length === 0) pool = readPlayersStore();
  const result = optimizeLineup(pool, constraints || {});
  res.json(result);
});

// --- admin upload/fetch (token protected) ---
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}
const upload = multer({ storage: multer.memoryStorage() });

function normalizePlayersFromRows(rows) {
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const idx = (...cands)=> cands.map(c=>header.indexOf(c)).find(i=>i!==-1) ?? -1;
  const iName = idx("name","player","playername");
  const iTeam = idx("team","teamabbrev","tm");
  const iPos  = idx("pos","position");
  const iSal  = idx("salary","sal","dk_salary","fd_salary");
  const iProj = idx("proj","projection","fpts","points","projected");
  if (iName<0 || iTeam<0 || iPos<0 || iSal<0) throw new Error("CSV needs name, team, pos, salary");

  const out=[];
  for (let r=1;r<rows.length;r++){
    const row = rows[r]; if (!row) continue;
    const name = String(row[iName]??"").trim();
    const team = String(row[iTeam]??"").trim().toUpperCase();
    const pos  = String(row[iPos] ??"").trim().toUpperCase();
    const salary = Number(String(row[iSal]??"").replace(/[^0-9.]/g,""));
    const proj = iProj>=0 ? Number(String(row[iProj]??"").replace(/[^0-9.-]/g,"")) : 0;
    if (!name || !team || !pos || !Number.isFinite(salary)) continue;
    out.push({ id:`${pos}:${team}:${name}`.replace(/\s+/g,"_"), name, team, pos, salary, proj });
  }
  if (!out.length) throw new Error("No valid players parsed");
  return out;
}

app.post("/api/admin/upload-players", requireAdmin, upload.single("file"), (req,res)=>{
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const csv = req.file.buffer.toString("utf8");
  const rows = parse(csv, { skip_empty_lines: true });
  const players = normalizePlayersFromRows(rows);
  fs.writeFileSync(RUNTIME_JSON, JSON.stringify(players,null,2));
  res.json({ ok:true, count: players.length });
});

app.post("/api/admin/fetch-players", requireAdmin, async (req,res)=>{
  try{
    const url = req.body?.url || DATA_CSV_URL;
    if (!url) return res.status(400).json({ error: "No CSV URL provided" });
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    const csv = await resp.text();
    const rows = parse(csv, { skip_empty_lines: true });
    const players = normalizePlayersFromRows(rows);
    fs.writeFileSync(RUNTIME_JSON, JSON.stringify(players,null,2));
    res.json({ ok:true, count: players.length, source:url });
  }catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});

app.listen(PORT, ()=> console.log(`Fantasy backend running at http://localhost:${PORT}`));
