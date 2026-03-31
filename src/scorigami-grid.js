// ============================================================
// SCORIGAMI GRID ANALYZER
// ============================================================
// Reads all historical daily data and reports grid density.
// Shows where scorigamis are most likely to come from.
//
// Usage:  node src/scorigami-grid.js
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
  const entries = []; // { pts, gp, date, franchise }
  const dirs = findDailyDirs();

  for (const dir of dirs) {
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
            gp,
            date: data.date,
            franchise: t.name || t.franchise,
          });
        }
      } catch (e) {}
    }
  }

  return entries;
}

function main() {
  const entries = loadAllEntries();
  console.log(`Total entries: ${entries.length.toLocaleString()}`);
  console.log(`Directories scanned: ${findDailyDirs().length}`);

  // Build grid
  const grid = {};    // "pts|gp" → count
  const gpCounts = {};  // gp → total occurrences
  const ptsCounts = {}; // pts → total occurrences

  for (const e of entries) {
    const key = `${e.pts}|${e.gp}`;
    grid[key] = (grid[key] || 0) + 1;
    gpCounts[e.gp] = (gpCounts[e.gp] || 0) + 1;
    ptsCounts[e.pts] = (ptsCounts[e.pts] || 0) + 1;
  }

  const uniqueCombos = Object.keys(grid).length;
  console.log(`Unique (pts, GP) combos: ${uniqueCombos}`);

  // Grid bounds
  const allPts = entries.map(e => e.pts);
  const allGP = entries.map(e => e.gp);
  const minPts = Math.min(...allPts), maxPts = Math.max(...allPts);
  const minGP = Math.min(...allGP), maxGP = Math.max(...allGP);
  const theoreticalCells = (maxPts - minPts + 1) * (maxGP - minGP + 1);
  const fillPct = ((uniqueCombos / theoreticalCells) * 100).toFixed(1);

  console.log(`\nGrid range: ${minPts}-${maxPts} pts × ${minGP}-${maxGP} GP`);
  console.log(`Theoretical cells: ${theoreticalCells.toLocaleString()}`);
  console.log(`Fill rate: ${fillPct}%`);
  console.log(`Empty cells (scorigami opportunities): ${(theoreticalCells - uniqueCombos).toLocaleString()}`);

  // Most common combos
  const sorted = Object.entries(grid).sort((a, b) => b[1] - a[1]);
  console.log(`\n--- Most common combos (most "anti-scorigami") ---`);
  for (let i = 0; i < Math.min(15, sorted.length); i++) {
    const [key, count] = sorted[i];
    const [pts, gp] = key.split("|");
    console.log(`  ${pts} pts / ${gp} GP — ${count} times`);
  }

  // Rarest combos (only happened once — near-scorigami zone)
  const singles = sorted.filter(([, count]) => count === 1);
  console.log(`\n--- Rarest combos (happened exactly once) ---`);
  console.log(`  ${singles.length} one-off combos in history`);
  // Show some examples from the edges
  const singlesByPPG = singles.map(([key]) => {
    const [pts, gp] = key.split("|").map(Number);
    return { pts, gp, ppg: (pts / gp).toFixed(2) };
  }).sort((a, b) => b.ppg - a.ppg);

  console.log(`\n  Highest efficiency one-offs:`);
  singlesByPPG.slice(0, 10).forEach(s =>
    console.log(`    ${s.pts} pts / ${s.gp} GP (${s.ppg} PPG)`)
  );
  console.log(`\n  Lowest efficiency one-offs:`);
  singlesByPPG.slice(-10).forEach(s =>
    console.log(`    ${s.pts} pts / ${s.gp} GP (${s.ppg} PPG)`)
  );

  // GP distribution — sparse GP values are scorigami-rich
  const gpSorted = Object.entries(gpCounts).sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log(`\n--- GP distribution ---`);
  for (const [gp, count] of gpSorted) {
    const bar = "█".repeat(Math.min(50, Math.round(count / entries.length * 500)));
    console.log(`  GP ${gp.padStart(2)}: ${count.toString().padStart(5)} ${bar}`);
  }

  // Pts distribution
  const ptsSorted = Object.entries(ptsCounts).sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log(`\n--- Points distribution ---`);
  for (const [pts, count] of ptsSorted) {
    const bar = "█".repeat(Math.min(50, Math.round(count / entries.length * 500)));
    console.log(`  ${pts.padStart(3)} pts: ${count.toString().padStart(5)} ${bar}`);
  }

  // Scorigami hotspots — GP ranges with the most empty cells
  console.log(`\n--- Scorigami hotspots by GP ---`);
  for (let gp = minGP; gp <= maxGP; gp++) {
    const filledAtGP = Object.keys(grid).filter(k => k.endsWith(`|${gp}`)).length;
    const ptsRangeAtGP = maxPts - minPts + 1;
    const emptyAtGP = ptsRangeAtGP - filledAtGP;
    const occurrences = gpCounts[gp] || 0;
    if (occurrences > 0) {
      console.log(`  GP ${String(gp).padStart(2)}: ${String(filledAtGP).padStart(3)} filled / ${ptsRangeAtGP} possible (${emptyAtGP} empty) — ${occurrences} occurrences`);
    }
  }
}

main();
