// ============================================================
// PROSPECT NIGHTS BACKFILL: night-by-night prospect points, 2013-14 .. 2025-26
// ============================================================
// One-time builder for data/prospect-nights.json, which records.js needs for the night-level prospect
// records (most prospect points in a night, most different prospects scoring in a night).
//
// data/prospect-history.json (exported once from F2) says which prospect was Active for which franchise in
// which period. This fetches each of those players' NHL game logs and keeps the games inside the periods
// he was Active, so every night gets { franchise, prospect points, which prospects scored }.
// Then it checks itself: each franchise's period totals must match F2's period numbers; mismatches are
// listed in the output file and the log.
//
// The records workflow runs this automatically when data/prospect-nights.json doesn't exist yet.
//
// Usage:
//   node src/prospect-nights-backfill.js
// Env:
//   PROSPECT_NIGHTS_FILE      default data/prospect-nights.json
// ============================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IN = path.join(ROOT, "data", "prospect-history.json");
const OUT = process.env.PROSPECT_NIGHTS_FILE || path.join(ROOT, "data", "prospect-nights.json");
const NHL = "https://api-web.nhle.com/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function gameLog(nhlId, season) {
  const code = `${season.slice(0, 4)}${Number(season.slice(0, 4)) + 1}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(`${NHL}/player/${nhlId}/game-log/${code}/2`);
    if (r.ok) return (await r.json()).gameLog || [];
    if (r.status === 404) return [];
    await sleep(1000 * attempt);
  }
  throw new Error(`NHL game log ${nhlId} ${code}: failed 3 times`);
}

(async () => {
  const ph = JSON.parse(fs.readFileSync(IN, "utf8"));

  // (season, period, pid) -> franchise code, for every Active stint
  const stint = {};
  const wanted = {};                                     // "pid|season" -> nhl id
  for (const s of ph.spans) {
    stint[`${s.season}|${s.period}|${s.pid}`] = s.code;
    const nhl = ph.nhl[s.pid];
    if (nhl) wanted[`${s.pid}|${s.season}`] = nhl;
    else log(`no NHL id for ${ph.names[s.pid] || s.pid}, skipped`);
  }
  const periodOf = (season, ymd) => (ph.seasons[season].rcps || []).find((r) => r.start <= ymd && ymd <= r.end);

  const nights = {};                                     // "date|code" -> { date, season, code, pts, scorers: Set }
  const keys = Object.keys(wanted);
  log(`${keys.length} player-seasons to fetch`);
  let i = 0;
  for (const k of keys) {
    const [pid, season] = k.split("|");
    const games = await gameLog(wanted[k], season);
    for (const g of games) {
      const pts = Number(g.points) || (Number(g.goals) || 0) + (Number(g.assists) || 0);
      if (!pts) continue;
      const p = periodOf(season, g.gameDate);
      if (!p) continue;
      const code = stint[`${season}|${p.n}|${pid}`];
      if (!code) continue;                                 // not Active for anyone that period
      const nk = `${g.gameDate}|${code}`;
      const n = (nights[nk] = nights[nk] || { date: g.gameDate, season, period: p.n, code, pts: 0, scorers: new Set() });
      n.pts += pts;
      n.scorers.add(pid);
    }
    if (++i % 50 === 0) log(`  ${i}/${keys.length}`);
    await sleep(120);
  }

  // check against F2's period totals
  const sums = {};
  for (const n of Object.values(nights)) { const k = `${n.season}|${n.period}|${n.code}`; sums[k] = (sums[k] || 0) + n.pts; }
  const mismatches = [];
  for (const p of ph.periods) {
    const k = `${p.season}|${p.period}|${p.code}`;
    if ((sums[k] || 0) !== p.pts) mismatches.push({ season: p.season, period: p.period, code: p.code, f2: p.pts, nights: sums[k] || 0 });
  }
  log(`${Object.keys(nights).length} franchise-nights; ${mismatches.length} period mismatches vs F2`);
  for (const m of mismatches.slice(0, 20)) log(`  ${m.season} P${m.period} ${m.code}: F2 ${m.f2}, nights ${m.nights}`);

  const out = {
    built: new Date().toISOString(),
    note: "Night-by-night prospect points per franchise, from NHL game logs of prospects Active that period (see src/prospect-nights-backfill.js).",
    mismatches,
    nights: Object.values(nights).sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code))
      .map((n) => ({ date: n.date, season: n.season, period: n.period, code: n.code, pts: n.pts, scorers: [...n.scorers].sort() })),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  log(`Wrote ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
