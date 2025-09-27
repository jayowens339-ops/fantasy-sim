// backend/server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;

// --- Admin secret (hard-coded) ---
const ADMIN_TOKEN = "Truetrenddfs4u!";

let players = []; // in-memory player storage

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
}));
app.use(bodyParser.json());

// --- Health Check ---
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", players: players.length });
});

// --- Auth Middleware for Admin Routes ---
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Get Players ---
app.get("/api/players", (req, res) => {
  res.json(players);
});

// --- Optimize Lineup ---
app.post("/api/optimize", (req, res) => {
  const salaryCap = Number(req.body.salaryCap) || 50000;

  // Sort players by projection/price ratio (value-based draft)
  const sorted = [...players].sort((a, b) => (b.proj / b.salary) - (a.proj / a.salary));

  let lineup = [];
  let usedSalary = 0;
  let projTotal = 0;

  for (let p of sorted) {
    if (usedSalary + p.salary <= salaryCap) {
      lineup.push(p);
      usedSalary += p.salary;
      projTotal += p.proj;
    }
  }

  res.json({
    lineup,
    usedSalary,
    projTotal,
  });
});

// --- Admin: Upload Players (CSV) ---
const upload = multer({ dest: "uploads/" });

app.post("/api/admin/upload-players", requireAdmin, upload.single("file"), (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => {
      results.push({
        name: data.name,
        team: data.team,
        pos: data.pos,
        salary: Number(data.salary),
        proj: Number(data.proj),
      });
    })
    .on("end", () => {
      players = results;
      fs.unlinkSync(req.file.path); // clean temp file
      res.json({ message: "Players uploaded successfully", count: players.length });
    });
});

// --- Admin: Load Sample Players ---
app.post("/api/admin/fetch-players", requireAdmin, (req, res) => {
  players = [
    { name: "J. Elite", team: "NE", pos: "QB", salary: 7200, proj: 22.5 },
    { name: "K. Gunslinger", team: "KC", pos: "QB", salary: 7600, proj: 23.1 },
    { name: "R. Thunder", team: "SF", pos: "RB", salary: 6900, proj: 18.0 },
    { name: "B. Workhorse", team: "DAL", pos: "RB", salary: 6800, proj: 16.9 },
    { name: "S. ValueBack", team: "CHI", pos: "RB", salary: 5200, proj: 14.2 },
    { name: "W. Alpha", team: "MIN", pos: "WR", salary: 8200, proj: 21.0 },
    { name: "C. DeepThreat", team: "MIA", pos: "WR", salary: 7000, proj: 17.2 },
    { name: "R. Slot", team: "LAR", pos: "WR", salary: 5400, proj: 12.8 },
    { name: "T. Rookie", team: "HOU", pos: "WR", salary: 4800, proj: 11.3 },
    { name: "T. Titan", team: "KC", pos: "TE", salary: 7300, proj: 17.8 },
    { name: "M. MidTier", team: "DET", pos: "TE", salary: 4500, proj: 9.4 },
    { name: "Steel Wall", team: "PIT", pos: "DST", salary: 3300, proj: 7.0 },
    { name: "Windy D", team: "CHI", pos: "DST", salary: 2800, proj: 6.1 }
  ];
  res.json({ message: "Sample players loaded", count: players.length });
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Fantasy backend running on port ${PORT}`);
});
