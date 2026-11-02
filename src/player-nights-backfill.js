// ============================================================
// PLAYER NIGHTS BACKFILL: every night since 2013-14, per franchise, per Active player
// ============================================================
// One-time builder for data/player-nights/YYYY-YY.json (one file per season, 2013-14 .. 2025-26), which the
// night records in src/night-records.js need for the stats the franchise totals can't give: goals, primary
// points, power-play points, empty-net points, and the most points from a single NHL game.
//
// data/active-stints.json (exported once from F2's player_period_pts, status ACTIVE) says which player was
// Active for which franchise in which period. Lineups are set per period, so a player Active for a franchise
// in a period counts for it on every night of that period. For every night in the data/daily-* files this
// fetches the NHL's scores for that date (api-web.nhle.com/v1/score/{date}: every goal with its scorer,
// assists in order, strength and empty-net flag; the same source src/nightly-report.js uses) and credits each
// goal and assist to the franchise that had the player Active.
//
// NHL ids: F2's are mostly right, but a few point at a namesake (the local F2 copy had the young defenceman
// Elias Pettersson's id for the Canucks forward). So before a season is built, every Active player's id is
// checked against the NHL's skater list for that season (api.nhle.com/stats/rest/en/skater/summary): same
// name and position, or it's swapped for the one skater with that name and position that season. Fixes are
// listed in the season's file (idFixes).
//
// It checks itself twice: each franchise's night must match the dayPts in the data/daily-* file, and each
// player's period must match his Active points in F2. Mismatches are listed in each season's file and the log.
//
// Usage:
//   node src/player-nights-backfill.js                     # every season without a file yet
//   node src/player-nights-backfill.js --season 2018-19    # just that one (rebuilt even if it exists)
//   node src/player-nights-backfill.js --force             # rebuild every season
// Env:
//   PLAYER_NIGHTS_DIR      default data/player-nights
//   NHL_FIXTURES           a folder of {date}.json score files to read instead of the NHL (testing)
// ============================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const OUT_DIR = process.env.PLAYER_NIGHTS_DIR || path.join(DATA, "player-nights");
const FIXTURES = process.env.NHL_FIXTURES || "";
const NHL = "https://api-web.nhle.com/v1";
const NHL_STATS = "https://api.nhle.com/stats/rest/en";
const ARGS = process.argv.slice(2);
const arg = (k) => { const i = ARGS.indexOf(k); return i >= 0 ? ARGS[i + 1] : null; };
const FORCE = ARGS.includes("--force");
const ONLY = arg("--season");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const CODES = { brian: "BEW", chris: "PWN", graeme: "GDD", jason: "JGC", matt: "MPP", richie: "RMS" };
const KNOWN = new Set(Object.values(CODES));
// the daily files name franchises the way the season did ("Cmack's PWN", "Matty's Little Heroes")
function codeFromName(name) {
  const n = String(name || "").trim();
  if (KNOWN.has(n.toUpperCase())) return n.toUpperCase();
  const o = (n.toLowerCase().match(/^[a-z]+/) || [""])[0];
  if (o === "cmack") return CODES.chris;
  if (o === "matty") return CODES.matt;
  return CODES[o] || null;
}

// one date's goals: [{ game, scorer, a1, a2, pp, en }] for regular-season games played that date
async function scores(ymd) {
  let j = null;
  if (FIXTURES) {
    const f = path.join(FIXTURES, `${ymd}.json`);
    if (!fs.existsSync(f)) throw new Error(`no fixture for ${ymd}`);
    j = JSON.parse(fs.readFileSync(f, "utf8"));
  } else {
    for (let attempt = 1; attempt <= 4 && !j; attempt++) {
      try {
        const r = await fetch(`${NHL}/score/${ymd}`);
        if (r.ok) j = await r.json();
        else if (r.status === 404) j = { games: [] };
        else throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        if (attempt === 4) throw new Error(`NHL score ${ymd}: ${e.message}`);
        await sleep(1500 * attempt);
      }
    }
  }
  const games = (j.games || []).filter((g) => g.gameDate === ymd && Number(g.gameType) === 2);
  const goals = [];
  for (const g of games) {
    const game = `${g.awayTeam.abbrev}@${g.homeTeam.abbrev}`;
    for (const goal of g.goals || []) {
      if ((goal.periodDescriptor || {}).periodType === "SO") continue;          // shootout goals aren't points
      const as = goal.assists || [];
      goals.push({ game, scorer: goal.playerId, a1: as[0] ? as[0].playerId : null, a2: as[1] ? as[1].playerId : null, pp: goal.strength === "pp", en: goal.goalModifier === "empty-net" });
    }
  }
  return { games: games.length, unfinished: games.filter((g) => !["OFF", "FINAL"].includes(g.gameState)).length, goals };
}

// a date's hockey season: Oct 2025 .. Jun 2026 -> "2025-26" (2020-21 started in January: still "2020-21")
function seasonOf(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

// the nights of a season, from the daily files: [{ date, teams: { CODE: { pts, gp } } }]
function dailyNights(season) {
  const dir = fs.existsSync(path.join(DATA, `daily-${season}`)) ? path.join(DATA, `daily-${season}`) : path.join(DATA, "daily");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const date = j.date || f.slice(0, 10);
    if ((j.season || seasonOf(date)) !== season) continue;
    const teams = {};
    for (const t of j.teams || []) {
      const code = codeFromName(t.franchise) || codeFromName(t.name);
      if (code) teams[code] = { pts: Number(t.dayPts) || 0, gp: Number(t.gp) || 0 };
    }
    out.push({ date, teams });
  }
  return out;
}

// the NHL's skaters for a season: { byId: { id: { n: normalized name, pos: 'F'|'D' } }, byName: { name: [ids] } }
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
async function seasonSkaters(season) {
  const id = `${season.slice(0, 4)}${Number(season.slice(0, 4)) + 1}`;
  let j = null;
  if (FIXTURES) {
    const f = path.join(FIXTURES, `skaters-${season}.json`);
    if (!fs.existsSync(f)) return null;
    j = JSON.parse(fs.readFileSync(f, "utf8"));
  } else {
    for (let attempt = 1; attempt <= 4 && !j; attempt++) {
      try {
        const r = await fetch(`${NHL_STATS}/skater/summary?limit=-1&cayenneExp=${encodeURIComponent(`seasonId=${id} and gameTypeId=2`)}`);
        if (r.ok) j = await r.json(); else throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        if (attempt === 4) { log(`  ${season}: NHL skater list unavailable (${e.message}); ids not checked`); return null; }
        await sleep(1500 * attempt);
      }
    }
  }
  const byId = {}, byName = {};
  for (const p of j.data || []) {
    const n = norm(p.skaterFullName), pos = p.positionCode === "D" ? "D" : "F";
    byId[p.playerId] = { n, pos };
    (byName[n] = byName[n] || []).push(p.playerId);
  }
  return { byId, byName };
}

// a season's NHL id for each player Active in it: F2's when it's a skater of that name and position that
// season, otherwise the one skater who is
function seasonIds(season, st, players, sk) {
  const ids = {}, fixes = [];
  const active = new Set();
  for (const byCode of Object.values(st.stints || {})) for (const list of Object.values(byCode)) for (const [pid, , gp] of list) if (gp > 0) active.add(pid);
  for (const [pid, p] of Object.entries(players)) {
    const [name, nhl, pos] = p;
    ids[pid] = nhl || null;
    if (!sk || !active.has(pid)) continue;
    const n = norm(name), have = nhl && sk.byId[nhl];
    if (have && have.n === n && (!pos || have.pos === pos)) continue;
    const cands = (sk.byName[n] || []).filter((x) => !pos || sk.byId[x].pos === pos);
    if (cands.length === 1 && cands[0] !== nhl) { ids[pid] = cands[0]; fixes.push({ pid, name, f2: nhl || null, nhl: cands[0] }); }
    else if (!have) fixes.push({ pid, name, f2: nhl || null, nhl: null, note: cands.length ? "several namesakes" : "not in the NHL's list" });
  }
  return { ids, fixes };
}

const blank = () => ({ pts: 0, gp: 0, g: 0, a1: 0, a2: 0, pp: 0, en: 0, games: {}, pl: {} });

async function buildSeason(season, st, players) {
  const rcps = st.rcps || [];
  const { ids, fixes } = seasonIds(season, st, players, await seasonSkaters(season));
  for (const f of fixes) log(`  ${season}: ${f.name} ${f.nhl ? `NHL id ${f.f2} -> ${f.nhl}` : `(${f.note}; kept ${f.f2})`}`);
  const periodOf = (ymd) => (rcps.find((r) => r.start <= ymd && ymd <= r.end) || {}).n || null;
  // period -> nhlId -> { code, pid }
  const own = {};
  for (const [rcp, byCode] of Object.entries(st.stints || {})) {
    const m = (own[rcp] = {});
    for (const [code, list] of Object.entries(byCode)) for (const [pid] of list) { const nhl = ids[pid]; if (nhl) m[nhl] = { code, pid }; }
  }
  const nights = {};
  const check = { nights: [], players: [], skipped: [] };
  const credited = {};                                       // "period|pid" -> points credited
  const days = dailyNights(season).filter((d) => periodOf(d.date));
  if (!days.length) { log(`${season}: no daily files with a period, skipped`); return null; }
  let i = 0;
  for (const d of days) {
    const period = periodOf(d.date);
    const sc = await scores(d.date);
    if (!FIXTURES) await sleep(120);
    const map = own[String(period)] || {};
    const teams = {};
    for (const code of Object.keys(d.teams)) teams[code] = Object.assign(blank(), { gp: d.teams[code].gp });
    const credit = (nhl, kind, goal) => {
      const o = map[nhl];
      if (!o) return;
      const t = (teams[o.code] = teams[o.code] || blank());
      const pl = (t.pl[o.pid] = t.pl[o.pid] || [0, 0, 0, 0, 0, goal.game]);  // g, a1, a2, pp, en, game
      t.pts += 1;
      if (kind === "G") { t.g += 1; pl[0] += 1; }
      else if (kind === "A1") { t.a1 += 1; pl[1] += 1; }
      else { t.a2 += 1; pl[2] += 1; }
      if (goal.pp) { t.pp += 1; pl[3] += 1; }
      if (goal.en) { t.en += 1; pl[4] += 1; }
      t.games[goal.game] = (t.games[goal.game] || 0) + 1;
      credited[`${period}|${o.pid}`] = (credited[`${period}|${o.pid}`] || 0) + 1;
    };
    for (const goal of sc.goals) {
      credit(goal.scorer, "G", goal);
      if (goal.a1) credit(goal.a1, "A1", goal);
      if (goal.a2) credit(goal.a2, "A2", goal);
    }
    for (const [code, t] of Object.entries(teams)) {
      const want = (d.teams[code] || {}).pts;
      if (want != null && want !== t.pts) check.nights.push({ date: d.date, code, daily: want, nhl: t.pts });
    }
    if (sc.unfinished) check.skipped.push({ date: d.date, unfinished: sc.unfinished });
    nights[d.date] = { p: period, games: sc.games, t: teams };
    if (++i % 25 === 0) log(`  ${season}: ${i}/${days.length} nights`);
  }
  // each player's Active points for the period, against F2
  for (const [rcp, byCode] of Object.entries(st.stints || {})) {
    for (const [code, list] of Object.entries(byCode)) {
      for (const [pid, pts] of list) {
        const got = credited[`${rcp}|${pid}`] || 0;
        if (got !== pts) check.players.push({ period: Number(rcp), code, pid, name: (players[pid] || [])[0] || pid, f2: pts, nhl: got, nhlId: ids[pid] || null });
      }
    }
  }
  return { season, built: new Date().toISOString(), idFixes: fixes, format: "nights[date] = { p: period, games, t: { CODE: { pts, gp, g, a1, a2, pp, en, games: { 'AWY@HOM': pts }, pl: { f2PlayerId: [g, a1, a2, pp, en, 'AWY@HOM'] } } } }", nights, check };
}

(async () => {
  const st = JSON.parse(fs.readFileSync(path.join(DATA, "active-stints.json"), "utf8"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const seasons = Object.keys(st.seasons).sort().filter((s) => !ONLY || s === ONLY);
  let bad = 0;
  for (const season of seasons) {
    const f = path.join(OUT_DIR, `${season}.json`);
    if (fs.existsSync(f) && !FORCE && !ONLY) { log(`${season}: already built`); continue; }
    log(`${season}: building`);
    const out = await buildSeason(season, st.seasons[season], st.players);
    if (!out) continue;
    fs.writeFileSync(f, JSON.stringify(out));
    const n = Object.keys(out.nights).length, c = out.check;
    log(`${season}: ${n} nights; ${c.nights.length} franchise-nights off the daily files, ${c.players.length} player-periods off F2${c.skipped.length ? `, ${c.skipped.length} nights with unfinished games` : ""}`);
    for (const x of c.nights.slice(0, 15)) log(`    night ${x.date} ${x.code}: daily ${x.daily}, NHL ${x.nhl}`);
    for (const x of c.players.slice(0, 15)) log(`    P${x.period} ${x.code} ${x.name}: F2 ${x.f2}, NHL ${x.nhl}${x.nhlId ? "" : " (no NHL id)"}`);
    bad += c.nights.length;
  }
  log(bad ? `Done, ${bad} franchise-nights to look at (listed in each file's check.nights).` : "Done.");
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
