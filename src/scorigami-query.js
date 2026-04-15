// ============================================================
// SCORIGAMI QUERY TOOL
// ============================================================
// Query the historical scoring database.
//
// Usage:
//   node src/scorigami-query.js rarest          # top 10 rarest combos
//   node src/scorigami-query.js rarest 25       # top 25 rarest
//   node src/scorigami-query.js lookup 14 3     # who scored 14 pts on 3 GP?
//   node src/scorigami-query.js check 14 3      # has 14 pts / 3 GP ever happened?
//   node src/scorigami-query.js franchise BEW   # rarest combos by a franchise
//   node src/scorigami-query.js efficiency       # most extreme PPG days ever
// ============================================================

const fs = require("fs");
const path = require("path");

const DATA_ROOT = path.join(__dirname, "..", "data");

function findDailyDirs() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs.readdirSync(DATA_ROOT)
    .filter(d => d.startsWith("daily") && fs.statSync(path.join(DATA_ROOT, d)).isDirectory())
    .map(d => path.join(DATA_ROOT, d));
}

function loadAllEntries() {
  const entries = [];
  for (const dir of findDailyDirs()) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        if (!data.teams || data.teams.length === 0) continue;
        const totalPts = data.teams.reduce((sum, t) => sum + (t.dayPts || 0), 0);
        if (totalPts === 0) continue;

        for (const t of data.teams) {
          const gp = t.gp || 0;
          if (gp <= 0) continue;
          entries.push({
            pts: Math.round(t.dayPts || 0),
            rawPts: t.dayPts || 0,
            gp,
            ppg: +(( t.dayPts || 0) / gp).toFixed(3),
            date: data.date,
            season: data.season || null,
            franchise: t.name || t.franchise,
          });
        }
      } catch (e) {}
    }
  }
  return entries;
}

function buildGrid(entries) {
  const grid = {}; // "pts|gp" → [entries]
  for (const e of entries) {
    const key = `${e.pts}|${e.gp}`;
    if (!grid[key]) grid[key] = [];
    grid[key].push(e);
  }
  return grid;
}

// ---- Commands ----

function cmdRarest(entries, grid, count) {
  // Sort combos by frequency ascending, then by PPG extremity as tiebreaker
  const sorted = Object.entries(grid)
    .map(([key, occurrences]) => {
      const [pts, gp] = key.split("|").map(Number);
      const ppg = (pts / gp).toFixed(3);
      return { key, pts, gp, ppg, count: occurrences.length, occurrences };
    })
    .sort((a, b) => a.count - b.count || Math.abs(b.ppg - 0.8) - Math.abs(a.ppg - 0.8));

  console.log(`\nTop ${count} rarest (pts, GP) combos:\n`);
  for (let i = 0; i < Math.min(count, sorted.length); i++) {
    const r = sorted[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${r.pts} pts / ${r.gp} GP (${r.ppg} PPG) — ${r.count}x`);
    for (const o of r.occurrences) {
      console.log(`      ${o.date} — ${o.franchise}${o.season ? ` (${o.season})` : ""}`);
    }
  }
}

function cmdLookup(grid, pts, gp) {
  const key = `${pts}|${gp}`;
  const occurrences = grid[key];

  if (!occurrences) {
    console.log(`\n  ${pts} pts / ${gp} GP has NEVER happened. This would be a scorigami.\n`);
    return;
  }

  console.log(`\n  ${pts} pts / ${gp} GP has happened ${occurrences.length} time(s):\n`);
  for (const o of occurrences) {
    console.log(`    ${o.date} — ${o.franchise} (${o.rawPts} raw pts)${o.season ? ` [${o.season}]` : ""}`);
  }
}

function cmdCheck(grid, pts, gp) {
  const key = `${pts}|${gp}`;
  const occurrences = grid[key];

  if (!occurrences) {
    console.log(`\n  SCORIGAMI — ${pts} pts / ${gp} GP has never happened.\n`);
  } else {
    console.log(`\n  NOT a scorigami — ${pts} pts / ${gp} GP has happened ${occurrences.length} time(s).\n`);
  }
}

function cmdFranchise(entries, grid, name) {
  const nameUpper = name.toUpperCase();
  const franchiseEntries = entries.filter(e =>
    (e.franchise || "").toUpperCase().includes(nameUpper)
  );

  if (franchiseEntries.length === 0) {
    console.log(`\n  No entries found matching "${name}".`);
    console.log(`  Available names: ${[...new Set(entries.map(e => e.franchise))].sort().join(", ")}`);
    return;
  }

  // Find this franchise's rarest combos
  const franchiseGrid = {};
  for (const e of franchiseEntries) {
    const key = `${e.pts}|${e.gp}`;
    if (!franchiseGrid[key]) franchiseGrid[key] = [];
    franchiseGrid[key].push(e);
  }

  // Cross-reference against the full grid to find how rare each combo is league-wide
  const results = Object.entries(franchiseGrid).map(([key, myOccurrences]) => {
    const [pts, gp] = key.split("|").map(Number);
    const globalCount = (grid[key] || []).length;
    return { pts, gp, ppg: (pts / gp).toFixed(3), myCount: myOccurrences.length, globalCount, occurrences: myOccurrences };
  }).sort((a, b) => a.globalCount - b.globalCount);

  console.log(`\n  Rarest combos for "${name}" (${franchiseEntries.length} total entries):\n`);
  for (let i = 0; i < Math.min(15, results.length); i++) {
    const r = results[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${r.pts} pts / ${r.gp} GP (${r.ppg} PPG) — ${r.myCount}x by them, ${r.globalCount}x league-wide`);
    for (const o of r.occurrences) {
      console.log(`      ${o.date}${o.season ? ` [${o.season}]` : ""}`);
    }
  }
}

function cmdEfficiency(entries) {
  const sorted = [...entries].sort((a, b) => b.ppg - a.ppg);

  console.log(`\nTop 10 highest efficiency days (PPG):\n`);
  for (let i = 0; i < Math.min(10, sorted.length); i++) {
    const e = sorted[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${e.ppg.toFixed(3)} PPG — ${e.pts} pts / ${e.gp} GP — ${e.franchise} (${e.date})`);
  }

  console.log(`\nTop 10 lowest efficiency days (PPG, min 3 GP):\n`);
  const lowSorted = entries.filter(e => e.gp >= 3).sort((a, b) => a.ppg - b.ppg);
  for (let i = 0; i < Math.min(10, lowSorted.length); i++) {
    const e = lowSorted[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${e.ppg.toFixed(3)} PPG — ${e.pts} pts / ${e.gp} GP — ${e.franchise} (${e.date})`);
  }
}

function cmdSeason(entries) {
  // Build grid from all NON-current-season data (everything not in data/daily/)
  const currentSeasonDir = path.join(DATA_ROOT, "daily");
  const historicalEntries = [];
  for (const dir of findDailyDirs()) {
    if (dir === currentSeasonDir) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        if (!data.teams || data.teams.length === 0) continue;
        const totalPts = data.teams.reduce((sum, t) => sum + (t.dayPts || 0), 0);
        if (totalPts === 0) continue;
        for (const t of data.teams) {
          const gp = t.gp || 0;
          if (gp <= 0) continue;
          historicalEntries.push({ pts: Math.round(t.dayPts || 0), gp });
        }
      } catch (e) {}
    }
  }

  // Build running grid starting with all historical data
  const grid = new Set();
  for (const e of historicalEntries) {
    grid.add(`${e.pts}|${e.gp}`);
  }
  console.log(`\nHistorical grid: ${grid.size} unique combos from previous seasons`);

  // Load current season dates chronologically
  if (!fs.existsSync(currentSeasonDir)) {
    console.log("No current season data in data/daily/");
    return;
  }

  const files = fs.readdirSync(currentSeasonDir)
    .filter(f => f.endsWith(".json") && f !== ".gitkeep")
    .sort();

  const scorigamis = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(currentSeasonDir, file), "utf-8"));
      if (!data.teams || data.teams.length === 0) continue;
      const totalPts = data.teams.reduce((sum, t) => sum + (t.dayPts || 0), 0);
      if (totalPts === 0) continue;

      for (const t of data.teams) {
        const gp = t.gp || 0;
        if (gp <= 0) continue;
        const pts = Math.round(t.dayPts || 0);
        const key = `${pts}|${gp}`;

        if (!grid.has(key)) {
          scorigamis.push({
            date: data.date,
            franchise: t.name || t.franchise,
            pts,
            gp,
            ppg: (pts / gp).toFixed(3),
          });
        }

        // Add to running grid so later dates don't re-flag the same combo
        grid.add(key);
      }
    } catch (e) {}
  }

  if (scorigamis.length === 0) {
    console.log("\nNo scorigamis this season.\n");
    return;
  }

  console.log(`\n${scorigamis.length} scorigami(s) this season:\n`);
  scorigamis.forEach((s, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${s.date} — ${s.franchise}: ${s.pts} pts / ${s.gp} GP (${s.ppg} PPG)`);
  });
}

// ---- Main ----

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log("Usage:");
    console.log("  node src/scorigami-query.js rarest [count]");
    console.log("  node src/scorigami-query.js lookup <pts> <gp>");
    console.log("  node src/scorigami-query.js check <pts> <gp>");
    console.log("  node src/scorigami-query.js franchise <name>");
    console.log("  node src/scorigami-query.js efficiency");
    console.log("  node src/scorigami-query.js season");
    process.exit(1);
  }

  console.log("Loading data...");
  const entries = loadAllEntries();
  const grid = buildGrid(entries);
  const dirs = findDailyDirs().length;
  console.log(`${entries.length.toLocaleString()} entries from ${dirs} directories, ${Object.keys(grid).length} unique combos`);

  switch (command) {
    case "rarest":
      cmdRarest(entries, grid, parseInt(args[1]) || 10);
      break;
    case "lookup":
      cmdLookup(grid, parseInt(args[1]), parseInt(args[2]));
      break;
    case "check":
      cmdCheck(grid, parseInt(args[1]), parseInt(args[2]));
      break;
    case "franchise":
      cmdFranchise(entries, grid, args.slice(1).join(" "));
      break;
    case "efficiency":
      cmdEfficiency(entries);
      break;
    case "season":
      cmdSeason(entries);
      break;
    default:
      console.log(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main();
