// ============================================================
// RECORDS: announce franchise and pool records as they're set
// ============================================================
// Every night at 10:30 PM Pacific (right after tonight's games are tallied), checks anything that just
// became final against 13+ seasons of Sparky history and posts to #sparky when a record is set or tied.
// Quiet when nothing is. A morning run after the nightly report catches up whatever the night run missed.
//
// What's checked:
//   PERIODS (when a period is final), each pool-wide AND per franchise:
//     most points / fewest points / best ppg / worst ppg   in ANY period
//     most points / fewest points / best ppg / worst ppg   in PERIOD N (e.g. best Period 1 ever)
//   NIGHTS (every night, once every game is final): most points in a night, pool-wide and per franchise.
//     No night lows: zero-point nights happen all the time.
//   MILESTONES (every night): a franchise passing a round 1,000 all-time points (every season since
//     2013-14 plus this one so far).
//   PLAYERS (every night), counting only a player's Active points while on that franchise:
//     a new leader for "most points by one player for <franchise>" (passed or tied),
//     a new leader for "most points by one player for a single franchise in Sparky history",
//     drafted players reaching 100 / 250 / 500 / 750 / 1,000 points for the franchise that drafted them
//     (prospect drafts and the 2013-14 / 2014-15 drafts; waiver pickups and trades never count).
//     History through 2025-26 is data/player-history.json (exported once from F2's player_period_pts);
//     this season comes from the players list in each nightly report file.
//   PROSPECTS (F2's prospect-race rule: taken in a prospect draft in the last five years, under 20 career
//     Active points when the season began; his Active points count for whoever had him Active), each
//     pool-wide AND per franchise, "most" only:
//       prospect points / different prospects scoring   in a night, in any period, in Period N, in a season
//       (season records post the night they're passed, "and counting"; ties aren't announced)
//     plus every round 100 all-time prospect points per franchise.
//     History: data/prospect-history.json (periods and seasons, exported once from F2) and
//     data/prospect-nights.json (nights, built from NHL game logs by src/prospect-nights-backfill.js).
//     This season: the players list in each nightly report file, against the season's prospect list.
//
// One line per franchise per stat, the strongest level only: a pool record isn't also announced as a
// franchise record, and an any-period record isn't also announced as a Period N record.
// A franchise needs history to have a franchise record (no "first Period 1 ever is a record").
//
// History (in this repo):
//   data/historical.json        period totals (FPts, GP) per franchise, seasons 2013-14 .. 2024-25
//                               (its "2026" season, 2025-26, stops at Period 9, so 2025-26 is rebuilt
//                               from data/daily instead, which has every night with its period number)
//   data/daily-YYYY-YY/*.json   every night 2013-14 .. 2024-25: dayPts, gp per franchise
//   data/daily/*.json           every night of 2025-26, with period numbers
// Current season (F2 + this repo):
//   GET /api/league             periods (rcps: number, start_date, end_date), teams (id, franchise)
//   GET /api/standings          per team: by_rcp [{rcp, points, games}]   -> period totals
//   data/nightly-report/*.json  per team per night: scored (= F2 fantasy points; same numbers)
//
// A period counts as final the morning after its end_date, once F2's points for it match the sum of
// the nightly reports (F2 adds a night's games after midnight). If they don't match yet, it waits for
// the next run; after 2 days it goes with F2's numbers and logs the mismatch.
//
// State: data/records/state.json remembers what's been checked, so nothing is announced twice.
// A missing state file means a fresh start: everything final this season gets checked in one post.
//
// Usage:
//   node src/records.js                      # check what's newly final, post records
//   node src/records.js --no-slack           # print only, don't write state
//   node src/records.js --seed               # mark everything final as checked, post nothing
//   node src/records.js --test               # post, but don't save state (test posts to another channel)
//   node src/records.js --today 2026-10-12   # pretend it's this date (testing)
//   node src/records.js --book               # print the current record book and exit
//
// Env:
//   F2_BASE, F2_USER, F2_PASSWORD     sparkypool.ca sign-in (same as the janitor)
//   SLACK_BOT_TOKEN, SLACK_CHANNEL    bot token (needs chat:write.customize) and where to post
//   SLACK_USERNAME                    default "Screech"
//   SLACK_ICON                        emoji or image URL; default ":trophy:"
//   RECORDS_DIR                       default data/records
//   PLAYER_MILESTONES                 default "100,250,500,750,1000"
//   FRANCHISE_CODES                   optional JSON override of franchise -> initialism
// ============================================================

const fs = require("fs");
const path = require("path");

const ARGS = process.argv.slice(2);
const arg = (k) => { const i = ARGS.indexOf(k); return i >= 0 ? ARGS[i + 1] : null; };
const NO_SLACK = ARGS.includes("--no-slack");
const SEED = ARGS.includes("--seed");
const BOOK = ARGS.includes("--book");
const TEST = ARGS.includes("--test");
const TZ = "America/Vancouver";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(2); } return v; };
const F2_BASE = need("F2_BASE").replace(/\/+$/, "");
const F2_USER = need("F2_USER");
const F2_PASSWORD = need("F2_PASSWORD");
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "";
const SLACK_USERNAME = process.env.SLACK_USERNAME || "Screech";
const SLACK_ICON = process.env.SLACK_ICON || ":trophy:";
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const OUT_DIR = process.env.RECORDS_DIR || path.join(DATA, "records");
const STATE_FILE = path.join(OUT_DIR, "state.json");
const MISMATCH_GRACE_DAYS = 2;

const log = (...a) => console.log(...a);

// ---- franchises ------------------------------------------------------------------------------
const CODES = Object.assign({ brian: "BEW", chris: "PWN", graeme: "GDD", jason: "JGC", matt: "MPP", richie: "RMS" },
  JSON.parse(process.env.FRANCHISE_CODES || "{}"));
const KNOWN = new Set(Object.values(CODES));
// announcements use each franchise's full current name from F2 ("Brian's Endless Winter"), filled in at startup;
// FRANCHISE_NAMES (JSON, code -> name) overrides. Falls back to the initialism.
const FULL = JSON.parse(process.env.FRANCHISE_NAMES || "{}");
const fname = (c) => FULL[c] || c;
// historical team names start with the owner: "Cmack's PWN", "Matty's Little Heroes", "Chris' Crew"
function codeFromName(name) {
  const n = String(name || "").trim();
  if (KNOWN.has(n.toUpperCase())) return n.toUpperCase();
  const owner = n.toLowerCase().match(/^[a-z]+/);
  if (!owner) return null;
  const o = owner[0];
  if (o === "cmack") return CODES.chris;
  if (o === "matty") return CODES.matt;
  return CODES[o] || null;
}

// ---- dates ------------------------------------------------------------------------------------
function pacificToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// a date's hockey season: Oct 2025 .. Jun 2026 -> "2025-26" (2020-21 started in January: still "2020-21")
function seasonOf(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}
const prettyDate = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// ---- history ------------------------------------------------------------------------------------
// periods: { season, period, code, pts, gp }      nights: { season, date, code, pts, gp }
function loadHistory() {
  const periods = [];
  const nights = [];

  // historical.json labels a season by the year it ends ("2014" = 2013-14). Skip "2026": rebuilt below.
  const hist = JSON.parse(fs.readFileSync(path.join(DATA, "historical.json"), "utf8"));
  for (const r of hist) {
    const end = Number(r.season);
    const season = `${end - 1}-${String(end).slice(2)}`;
    if (season === "2025-26") continue;
    for (const [owner, v] of Object.entries(r.teams || {})) {
      const code = codeFromName(owner);
      if (code && v.GP) periods.push({ season, period: r.period, code, pts: v.FPts, gp: v.GP });
    }
  }

  // nights: every daily-* folder; data/daily is 2025-26 and also carries period numbers
  const p2526 = {};
  for (const dir of fs.readdirSync(DATA).filter((d) => /^daily(-\d{4}-\d{2})?$/.test(d)).sort()) {
    for (const f of fs.readdirSync(path.join(DATA, dir)).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, dir, f), "utf8"));
      const date = j.date || f.slice(0, 10);
      const season = dir === "daily" ? seasonOf(date) : dir.slice(6);
      for (const t of j.teams || []) {
        const code = codeFromName(t.franchise) || codeFromName(t.name);
        if (!code) continue;
        const pts = Number(t.dayPts) || 0, gp = Number(t.gp) || 0;
        nights.push({ season, date, code, pts, gp });
        if (dir === "daily" && j.period >= 1) {
          const k = `${j.period}|${code}`;
          p2526[k] = p2526[k] || { season, period: j.period, code, pts: 0, gp: 0 };
          p2526[k].pts += pts;
          p2526[k].gp += gp;
        }
      }
    }
  }
  for (const p of Object.values(p2526)) if (p.gp) periods.push(p);
  return { periods, nights, seasonTotals: seasonTotals(hist, nights, p2526) };
}

// All-time points per season per franchise, for milestones: the period totals, except where a season's
// period history is missing a franchise for a period (2014-15's last period has no PWN or MPP), then that
// franchise's season comes from the nightly files instead. 2025-26 comes from its nightly files.
function seasonTotals(hist, nights, p2526) {
  const out = {};                                         // season -> code -> points
  const add = (season, code, pts) => { out[season] = out[season] || {}; out[season][code] = (out[season][code] || 0) + pts; };
  const fromNights = {};
  for (const n of nights) { fromNights[n.season] = fromNights[n.season] || {}; fromNights[n.season][n.code] = (fromNights[n.season][n.code] || 0) + n.pts; }

  const bySeason = {};
  for (const r of hist) {
    const end = Number(r.season);
    const season = `${end - 1}-${String(end).slice(2)}`;
    if (season === "2025-26") continue;
    (bySeason[season] = bySeason[season] || []).push(r);
  }
  for (const [season, rows] of Object.entries(bySeason)) {
    const codes = new Set();
    for (const r of rows) for (const owner of Object.keys(r.teams || {})) { const c = codeFromName(owner); if (c) codes.add(c); }
    for (const code of codes) {
      const gap = rows.some((r) => !Object.keys(r.teams || {}).some((o) => codeFromName(o) === code));
      if (gap && fromNights[season] && fromNights[season][code] != null) { add(season, code, fromNights[season][code]); continue; }
      for (const r of rows) for (const [owner, v] of Object.entries(r.teams || {})) if (codeFromName(owner) === code) add(season, code, v.FPts || 0);
    }
  }
  for (const p of Object.values(p2526)) add(p.season, p.code, p.pts);
  return out;
}

// ---- players ----------------------------------------------------------------------------------------
function loadPlayerHistory() {
  const f = path.join(DATA, "player-history.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// this season's nights that carry a players list: [{ date, rows: [{ code, pid, name, pts }] }]
function currentPlayerNights(season, teamCode, today) {
  const dir = path.join(DATA, "nightly-report");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!r.date || r.date > today || seasonOf(r.date) !== season) continue;
    if (!(r.period >= 1) || !r.games || (r.notFinal || []).length || !r.players) continue;
    const rows = [];
    for (const [pid, p] of Object.entries(r.players)) {
      const code = teamCode[p.team];
      if (code && p.pts) rows.push({ code, pid, name: p.name, pts: p.pts });
    }
    out.push({ date: r.date, period: r.period, rows });
  }
  return out;
}

const fmtN = (n) => Number(n).toLocaleString("en-US");

// leader of a set of keys by points (ties: whoever's ahead in the order given, i.e. the incumbent)
function leaderOf(keys, pts, incumbent) {
  let best = incumbent && keys.includes(incumbent) ? incumbent : null;
  for (const k of keys) if (!best || (pts[k] || 0) > (pts[best] || 0)) best = k;
  return best;
}

function playerChecks(ph, pnights, doneSet, codesNow) {
  const MARKS = String(process.env.PLAYER_MILESTONES || "100,250,500,750,1000").split(",").map(Number).filter(Boolean).sort((a, b) => a - b);
  const pts = {};                                         // "CODE|pid" -> points for that franchise
  const names = { ...(ph.players || {}) };
  for (const [code, byPid] of Object.entries(ph.points || {})) for (const [pid, v] of Object.entries(byPid)) pts[`${code}|${pid}`] = v;
  const drafted = ph.drafted || {};
  const keysOf = (code) => Object.keys(pts).filter((k) => k.startsWith(code + "|"));
  const nm = (k) => names[k.split("|")[1]] || k.split("|")[1];

  const lines = [];
  const newDates = [];
  let poolLeader = leaderOf(Object.keys(pts), pts);
  const frLeader = Object.fromEntries(codesNow.map((c) => [c, leaderOf(keysOf(c), pts)]));

  for (const night of pnights) {
    const isNew = !doneSet.has(night.date);
    const before = {};
    for (const r of night.rows) {
      const k = `${r.code}|${r.pid}`;
      before[k] = pts[k] || 0;
      pts[k] = before[k] + r.pts;
      if (r.name) names[r.pid] = r.name;
    }
    const touched = [...new Set(night.rows.map((r) => r.code))];

    // pool: most points by one player for a single franchise
    const prevPool = poolLeader;
    poolLeader = leaderOf(Object.keys(pts), pts, prevPool);
    const poolLine = new Set();
    if (isNew && prevPool) {
      for (const k of Object.keys(before)) {
        if (k === prevPool) continue;
        const prevPts = before[prevPool] != null ? before[prevPool] : pts[prevPool];
        if (before[k] < prevPts && pts[k] >= pts[prevPool]) {
          const [code] = k.split("|"), [pc] = prevPool.split("|");
          const verb = pts[k] > pts[prevPool] ? "passed" : "tied";
          lines.push(`*${nm(k)}* ${verb} ${nm(prevPool)} (${fname(pc)}, ${fmtN(pts[prevPool])}) for the most points by one player for a single franchise in Sparky history: ${fmtN(pts[k])} for ${fname(code)}.`);
          poolLine.add(k);
        }
      }
    }

    // each franchise's own leader
    for (const code of touched) {
      const prev = frLeader[code];
      frLeader[code] = leaderOf(keysOf(code), pts, prev);
      if (!isNew || !prev) continue;
      const prevPts = before[prev] != null ? before[prev] : pts[prev];
      for (const k of Object.keys(before)) {
        if (k === prev || !k.startsWith(code + "|") || poolLine.has(k)) continue;
        if (before[k] < prevPts && pts[k] >= pts[prev]) {
          const verb = pts[k] > pts[prev] ? "passed" : "tied";
          lines.push(`*${nm(k)}* ${verb} ${nm(prev)} for the most points by one player for ${fname(code)}: ${fmtN(pts[k])}.`);
        }
      }
    }

    // drafted players' milestones, for the franchise that drafted them
    if (isNew) {
      for (const k of Object.keys(before)) {
        const [code, pid] = k.split("|");
        const how = (drafted[code] || {})[pid];
        if (!how) continue;
        for (const m of MARKS) {
          if (before[k] < m && pts[k] >= m) {
            lines.push(`*${nm(k)}* hit ${fmtN(m)} points for ${fname(code)} on ${prettyDate(night.date)}. ${fname(code)} drafted him in the ${how}.`);
          }
        }
      }
      newDates.push(night.date);
    }
  }
  return { lines, newDates };
}

// ---- prospects -------------------------------------------------------------------------------------
function loadJson(name) {
  const f = path.join(DATA, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

const PROSPECT_STATS = [
  { key: "pts", label: "most prospect points", val: (e) => e.pts, dir: 1 },
  { key: "n", label: "most different prospects scoring", val: (e) => e.n, dir: 1 },
];

// the strongest level a value reaches against prior entries, with in-batch rivals: a pool level only goes to
// the batch's best (or those tied with it)
function prospectHit(e, prior, stat, levels, batch) {
  const beaten = batch.some((x) => x !== e && stat.val(x) > stat.val(e));
  const lv = levels.filter((l) => !(beaten && l.id.startsWith("pool")));
  // prospect counts are small numbers that tie constantly: only new records are announced, never ties
  for (let i = 0; i < lv.length; i++) {
    const hit = bestLevel(e, prior, stat, lv.slice(i));
    if (!hit) return null;
    if (!hit.tie) return hit;
    i = lv.indexOf(hit.level);
  }
  return null;
}

function prospectChecks(pros, pnightsHist, pnights, season, periodsFinal, state) {
  const out = { nightLines: {}, periodLines: {}, otherLines: [], newNights: [], newPeriods: [] };
  const cur = pros.current && pros.current.season === season ? new Set(pros.current.prospects) : null;
  if (!cur) { log(`Prospect list is for ${pros.current && pros.current.season}, not ${season}: prospect checks skipped (re-export data/prospect-history.json).`); return out; }
  const names = pros.names || {};

  // history
  const hNights = pnightsHist ? pnightsHist.nights.map((n) => ({ season: n.season, date: n.date, code: n.code, pts: n.pts, n: n.scorers.length })) : null;
  const hPeriods = pros.periods.map((p) => ({ season: p.season, period: p.period, code: p.code, pts: p.pts, n: p.scorers.length, scorers: p.scorers }));
  const seasonAgg = (rows) => {
    const m = {};
    for (const r of rows) {
      const k = `${r.season}|${r.code}`;
      m[k] = m[k] || { season: r.season, code: r.code, pts: 0, set: new Set() };
      m[k].pts += r.pts;
      for (const s of r.scorers) m[k].set.add(s);
    }
    return Object.values(m).map((x) => ({ season: x.season, code: x.code, pts: x.pts, n: x.set.size }));
  };
  const hSeasons = seasonAgg(hPeriods);

  // this season, night by night: { date, period, code, pts, scorers[] }
  const cNights = [];
  for (const night of pnights) {
    const by = {};
    for (const r of night.rows) {
      if (!cur.has(r.pid)) continue;
      by[r.code] = by[r.code] || { season, date: night.date, period: night.period, code: r.code, pts: 0, scorers: [], who: [] };
      by[r.code].pts += r.pts;
      by[r.code].scorers.push(r.pid);
      by[r.code].who.push(`${r.name || names[r.pid] || r.pid} ${r.pts}`);
      if (r.name) names[r.pid] = r.name;
    }
    cNights.push({ date: night.date, period: night.period, teams: Object.values(by).map((x) => ({ ...x, n: x.scorers.length })) });
  }

  const doneNights = new Set(state.prospectNights || []);
  const donePeriods = new Set(state.prospectPeriods || []);
  const nightLevels = () => [{ id: "pool-any", filter: () => true }];
  const allTime = {};                                                        // code -> all-time prospect points
  for (const p of hPeriods) allTime[p.code] = (allTime[p.code] || 0) + p.pts;
  const seasonRun = {};                                                      // code -> { pts, set }
  const bookNights = hNights ? [...hNights] : null;

  for (const night of cNights) {
    const isNew = !doneNights.has(night.date);
    const lines = [];
    // night records (need night history)
    if (isNew && bookNights) {
      for (const e of night.teams) {
        for (const stat of PROSPECT_STATS) {
          const levels = [{ id: "pool-any", filter: () => true }, { id: "fr-any", filter: (p) => p.code === e.code }];
          const hit = prospectHit(e, bookNights, stat, levels, night.teams);
          if (!hit) continue;
          const what = hit.level.id === "pool-any" ? `the pool record for ${stat.label} in a night` : `their own record for ${stat.label} in a night`;
          const ref = (o) => `${stat.val(o)}, ${hit.level.id === "pool-any" ? `${fname(o.code)}, ` : ""}${prettyDate(o.date)}`;
          const old = hit.tie ? ` Shared with ${hit.ties.map(ref).join("; ")}.` : ` Old mark: ${ref(hit.old)}.`;
          lines.push(`*${fname(e.code)}* ${hit.tie ? "tied" : "set"} ${what}: ${stat.val(e)} on ${prettyDate(e.date)} (${e.who.join(", ")}).${old}`);
        }
      }
    }
    if (bookNights) bookNights.push(...night.teams);

    // season records, the night they're passed; all-time milestones
    for (const e of night.teams) {
      const sr = (seasonRun[e.code] = seasonRun[e.code] || { pts: 0, set: new Set() });
      const before = { pts: sr.pts, n: sr.set.size };
      sr.pts += e.pts;
      for (const s of e.scorers) sr.set.add(s);
      const after = { pts: sr.pts, n: sr.set.size };
      const prevAll = allTime[e.code] || 0;
      allTime[e.code] = prevAll + e.pts;
      if (!isNew) continue;
      for (const stat of PROSPECT_STATS) {
        const k = stat.key;
        const poolBest = Math.max(0, ...hSeasons.map((x) => x[k]));
        const frBest = Math.max(0, ...hSeasons.filter((x) => x.code === e.code).map((x) => x[k]));
        const rivalsNow = Object.entries(seasonRun).filter(([c]) => c !== e.code).map(([, v]) => (k === "pts" ? v.pts : v.set.size));
        const poolNow = Math.max(poolBest, ...rivalsNow);
        if (before[k] <= poolNow && after[k] > poolNow) {
          const holder = hSeasons.find((x) => x[k] === poolBest);
          const old = after[k] > poolBest && poolNow === poolBest && holder ? ` Old mark: ${poolBest}, ${fname(holder.code)}, ${holder.season}.` : "";
          lines.push(`*${fname(e.code)}* now holds the pool record for ${stat.label} in a season: ${after[k]} and counting.${old}`);
        } else if (frBest > 0 && before[k] <= frBest && after[k] > frBest) {
          const holder = hSeasons.find((x) => x.code === e.code && x[k] === frBest);
          lines.push(`*${fname(e.code)}* now holds their own record for ${stat.label} in a season: ${after[k]} and counting. Old mark: ${frBest}, ${holder.season}.`);
        }
      }
      const from = Math.floor(prevAll / 100), to = Math.floor(allTime[e.code] / 100);
      for (let m = from + 1; m <= to; m++) lines.push(`*${fname(e.code)}* passed ${fmtN(m * 100)} all-time prospect points on ${prettyDate(e.date)}.`);
    }
    if (isNew) { out.nightLines[night.date] = lines; out.newNights.push(night.date); }
  }

  // periods: final periods of this season not yet checked
  const bookPeriods = [...hPeriods];
  for (const n of [...periodsFinal].sort((a, b) => a - b)) {
    const teams = {};
    for (const night of cNights.filter((x) => x.period === n)) {
      for (const t of night.teams) {
        teams[t.code] = teams[t.code] || { season, period: n, code: t.code, pts: 0, set: new Set() };
        teams[t.code].pts += t.pts;
        for (const s of t.scorers) teams[t.code].set.add(s);
      }
    }
    const batch = Object.values(teams).map((t) => ({ season, period: n, code: t.code, pts: t.pts, n: t.set.size }));
    if (!donePeriods.has(`${season}|P${n}`)) {
      const lines = [];
      for (const e of batch) {
        for (const stat of PROSPECT_STATS) {
          const hit = prospectHit(e, bookPeriods, stat, periodLevels(e), batch);
          if (!hit) continue;
          const what = {
            "pool-any": `the pool record for ${stat.label} in a period`,
            "pool-n": `the pool record for ${stat.label} in Period ${n}`,
            "fr-any": `their own record for ${stat.label} in a period`,
            "fr-n": `their own record for ${stat.label} in Period ${n}`,
          }[hit.level.id];
          const ref = (o) => `${stat.val(o)}, ${hit.level.id.startsWith("pool") ? `${fname(o.code)}, ` : ""}${hit.level.id.endsWith("-n") ? o.season : `Period ${o.period} ${o.season}`}`;
          const old = hit.tie ? ` Shared with ${hit.ties.map(ref).join("; ")}.` : ` Old mark: ${ref(hit.old)}.`;
          lines.push(`*${fname(e.code)}* ${hit.tie ? "tied" : "set"} ${what}: ${stat.val(e)}.${old}`);
        }
      }
      out.periodLines[n] = lines;
      out.newPeriods.push(`${season}|P${n}`);
    }
    bookPeriods.push(...batch);
  }
  if (!bookNights) log("No data/prospect-nights.json yet: prospect night records skipped (run src/prospect-nights-backfill.js).");
  return out;
}

// ---- F2 -------------------------------------------------------------------------------------------
const jar = {};
const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function f2Login() {
  const r = await fetch(`${F2_BASE}/door`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: new URLSearchParams({ name: F2_USER, password: F2_PASSWORD }).toString(),
    redirect: "manual",
  });
  const list = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
  for (const c of list) { const m = String(c).match(/^\s*([^=;\s]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
  if (!Object.keys(jar).length) throw new Error(`F2 sign-in failed (HTTP ${r.status})`);
}

async function f2(p) {
  const r = await fetch(F2_BASE + p, { headers: { Cookie: cookie() } });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok || !ct.includes("json")) throw new Error(`F2 ${p}: HTTP ${r.status}`);
  return r.json();
}

// ---- current season -------------------------------------------------------------------------------
// nights from the nightly report files: only full nights (every game final) of a numbered period
function currentNights(season, teamCode, today) {
  const dir = path.join(DATA, "nightly-report");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!r.date || r.date > today || seasonOf(r.date) !== season) continue;     // tonight counts once every game is final
    if (!(r.period >= 1) || !r.games || (r.notFinal || []).length) continue;
    for (const [tid, t] of Object.entries(r.teams || {})) {
      const code = teamCode[tid];
      if (code) out.push({ season, date: r.date, period: r.period, code, pts: t.scored || 0, gp: null });
    }
  }
  return out;
}

// periods that are final: ended before today, and F2's points agree with the nightly reports
function currentPeriods(league, standings, nights, season, teamCode, today) {
  const out = [];
  const waiting = [];
  for (const rcp of (league.rcps || []).filter((r) => r.number >= 1 && r.end_date < today).sort((a, b) => a.number - b.number)) {
    const rows = [];
    let mismatch = [];
    for (const team of standings) {
      const code = teamCode[team.id];
      const b = (team.by_rcp || []).find((x) => x.rcp === rcp.number);
      if (!code || !b) continue;
      const nightly = nights.filter((n) => n.code === code && n.period === rcp.number).reduce((s, n) => s + n.pts, 0);
      if (nightly !== b.points) mismatch.push(`${code} F2 ${b.points} vs nightly ${nightly}`);
      rows.push({ season, period: rcp.number, code, pts: b.points, gp: b.games || 0 });
    }
    if (!rows.length) continue;
    const overdue = addDays(rcp.end_date, 1 + MISMATCH_GRACE_DAYS) <= today;
    if (mismatch.length && !overdue) { waiting.push(`Period ${rcp.number} (${mismatch.join(", ")})`); continue; }
    if (mismatch.length) log(`Period ${rcp.number}: using F2's numbers despite: ${mismatch.join(", ")}`);
    out.push(...rows.filter((r) => r.gp));
  }
  return { periods: out, waiting };
}

// ---- record checks ---------------------------------------------------------------------------------
const ppg = (e) => e.pts / e.gp;
const PERIOD_STATS = [
  { key: "pts-hi", label: "most points", val: (e) => e.pts, dir: 1 },
  { key: "pts-lo", label: "fewest points", val: (e) => e.pts, dir: -1 },
  { key: "ppg-hi", label: "best ppg", val: ppg, dir: 1 },
  { key: "ppg-lo", label: "worst ppg", val: ppg, dir: -1 },
];
const NIGHT_STATS = [{ key: "night-hi", label: "most points", val: (e) => e.pts, dir: 1 }];
const EPS = 1e-9;

// the strongest level at which e sets or ties a record for one stat, or null
function bestLevel(e, prior, stat, levels) {
  const v = stat.val(e);
  for (const lv of levels) {
    const pool = prior.filter(lv.filter);
    if (!pool.length) continue;
    let rec = null;
    for (const p of pool) if (!rec || stat.dir * (stat.val(p) - stat.val(rec)) > EPS) rec = p;
    const diff = stat.dir * (v - stat.val(rec));
    if (diff > EPS) return { level: lv, old: rec, tie: false };
    if (Math.abs(diff) <= EPS) return { level: lv, old: rec, tie: true, ties: pool.filter((p) => Math.abs(stat.val(p) - v) <= EPS) };
  }
  return null;
}

function periodLevels(e) {
  return [
    { id: "pool-any", filter: () => true },
    { id: "pool-n", filter: (p) => p.period === e.period },
    { id: "fr-any", filter: (p) => p.code === e.code },
    { id: "fr-n", filter: (p) => p.code === e.code && p.period === e.period },
  ];
}
function nightLevels(e) {
  return [
    { id: "pool-any", filter: () => true },
    { id: "fr-any", filter: (p) => p.code === e.code },
  ];
}

// ---- wording -------------------------------------------------------------------------------------
const fmtPpg = (x) => x.toFixed(2);
function statValue(stat, e) {
  return stat.key.startsWith("ppg") ? `${fmtPpg(ppg(e))} ppg (${e.pts} in ${e.gp} GP)` : `${e.pts} points in ${e.gp} GP`;
}
function oldPeriodRef(stat, o, levelId) {
  const v = stat.key.startsWith("ppg") ? `${fmtPpg(ppg(o))}` : `${o.pts}`;
  const who = levelId.startsWith("pool") ? `${fname(o.code)}, ` : "";
  const when = levelId.endsWith("-n") ? o.season : `Period ${o.period} ${o.season}`;
  return `${v}, ${who}${when}`;
}

function periodLine(e, stat, hit) {
  const what = {
    "pool-any": `the pool record for ${stat.label} in a period`,
    "pool-n": `the pool record for ${stat.label} in Period ${e.period}`,
    "fr-any": `their own record for ${stat.label} in a period`,
    "fr-n": `their own record for ${stat.label} in Period ${e.period}`,
  }[hit.level.id];
  const verb = hit.tie ? "tied" : "set";
  const old = hit.tie
    ? ` Shared with ${hit.ties.map((t) => oldPeriodRef(stat, t, hit.level.id)).join("; ")}.`
    : ` Old mark: ${oldPeriodRef(stat, hit.old, hit.level.id)}.`;
  return `*${fname(e.code)}* ${verb} ${what}: ${statValue(stat, e)}.${old}`;
}

const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"];
function milestoneLine(code, mark, date, already, sameNight) {
  const n = already.length;
  const nth = ORDINAL[n] || `No. ${n + 1}`;
  const names = already.map(fname);
  const list = n <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[n - 1]}`;
  const after = n ? `, after ${list}` : "";
  const tied = sameNight.length ? ` ${sameNight.map(fname).join(" and ")} got there the same night.` : "";
  return `*${fname(code)}* passed ${mark.toLocaleString("en-US")} all-time points on ${prettyDate(date)}. ${nth} franchise to get there${after}.${tied}`;
}

function nightLine(e, stat, hit) {
  const what = hit.level.id === "pool-any" ? "the pool record for most points in a night" : "their own record for most points in a night";
  const ref = (o) => `${o.pts}, ${hit.level.id === "pool-any" ? `${fname(o.code)}, ` : ""}${prettyDate(o.date)}`;
  const old = hit.tie ? ` Shared with ${hit.ties.map(ref).join("; ")}.` : ` Old mark: ${ref(hit.old)}.`;
  return `*${fname(e.code)}* ${hit.tie ? "tied" : "set"} ${what}: ${e.pts} points on ${prettyDate(e.date)}.${old}`;
}

// ---- record book (for --book) ------------------------------------------------------------------------
function printBook(periods, nights) {
  const codes = [...new Set(periods.map((p) => p.code))].sort();
  const top = (arr, stat) => arr.reduce((a, b) => (!a || stat.dir * (stat.val(b) - stat.val(a)) > EPS ? b : a), null);
  log("POOL");
  for (const s of PERIOD_STATS) { const t = top(periods, s); log(`  ${s.label} in a period: ${oldPeriodRef(s, t, "pool-any")}`); }
  const n = top(nights, NIGHT_STATS[0]);
  log(`  most points in a night: ${n.pts}, ${n.code}, ${prettyDate(n.date)}`);
  for (const c of codes) {
    log(c);
    for (const s of PERIOD_STATS) { const t = top(periods.filter((p) => p.code === c), s); log(`  ${s.label} in a period: ${oldPeriodRef(s, t, "fr-any")}`); }
    const cn = top(nights.filter((x) => x.code === c), NIGHT_STATS[0]);
    if (cn) log(`  most points in a night: ${cn.pts}, ${prettyDate(cn.date)}`);
  }
}

// ---- Slack -------------------------------------------------------------------------------------------
async function slack(text) {
  if (NO_SLACK || !SLACK_TOKEN || !SLACK_CHANNEL) { log("(not posting to Slack)"); return false; }
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({
      channel: SLACK_CHANNEL, text, unfurl_links: false,
      username: SLACK_USERNAME,
      ...(SLACK_ICON.startsWith("http") ? { icon_url: SLACK_ICON } : { icon_emoji: SLACK_ICON }),
    }),
  });
  const o = await r.json();
  if (!o.ok) throw new Error(`Slack: ${o.error}`);
  return true;
}

// ---- main ---------------------------------------------------------------------------------------------
(async () => {
  const today = arg("--today") || pacificToday();
  const hist = loadHistory();

  await f2Login();
  const league = await f2("/api/league");
  const firstRcp = (league.rcps || []).filter((r) => r.number >= 1).sort((a, b) => a.number - b.number)[0];
  if (!firstRcp) { log("F2 has no scoring periods."); return; }
  const season = seasonOf(firstRcp.start_date);
  const teamCode = Object.fromEntries((league.teams || []).map((t) => [t.id, CODES[t.franchise] || codeFromName(t.name)]));
  for (const t of league.teams || []) { const c = teamCode[t.id]; if (c && t.name && !process.env.FRANCHISE_NAMES) FULL[c] = String(t.name).trim(); }

  // never let an old copy of this season in the history files double up with F2's
  const histPeriods = hist.periods.filter((p) => p.season !== season);
  const histNights = hist.nights.filter((n) => n.season !== season);

  const nights = currentNights(season, teamCode, today);
  const standings = await f2("/api/standings");
  const { periods, waiting } = currentPeriods(league, standings, nights, season, teamCode, today);
  for (const w of waiting) log(`Not final yet, will retry: ${w}`);

  if (BOOK) {
    printBook([...histPeriods, ...periods], [...histNights, ...nights]);
    const all = {};
    for (const [s, byCode] of Object.entries(hist.seasonTotals)) if (s !== season) for (const [c, v] of Object.entries(byCode)) all[c] = (all[c] || 0) + v;
    for (const n of nights) all[n.code] = (all[n.code] || 0) + n.pts;
    log("ALL-TIME POINTS");
    for (const [c, v] of Object.entries(all).sort((a, b) => b[1] - a[1])) log(`  ${c} ${v.toLocaleString("en-US")}`);
    return;
  }

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { periods: [], nights: [], playerNights: [] };
  const donePeriods = new Set(state.periods || []);
  const doneNights = new Set(state.nights || []);
  const pKey = (p) => `${p.season}|P${p.period}`;

  // check in time order; each checked item joins the book before the next one is checked
  const lines = { periods: {}, nights: {} };
  const bookPeriods = [...histPeriods, ...periods.filter((p) => donePeriods.has(pKey(p)))];
  const bookNights = [...histNights, ...nights.filter((n) => doneNights.has(n.date))];

  const newPeriodNums = [...new Set(periods.filter((p) => !donePeriods.has(pKey(p))).map((p) => p.period))].sort((a, b) => a - b);
  for (const n of newPeriodNums) {
    const batch = periods.filter((p) => p.period === n);
    lines.periods[n] = periodRecords(batch, [...bookPeriods]);
    bookPeriods.push(...batch);
    donePeriods.add(`${season}|P${n}`);
  }

  const newDates = [...new Set(nights.filter((x) => !doneNights.has(x.date)).map((x) => x.date))].sort();
  for (const d of newDates) {
    const batch = nights.filter((x) => x.date === d);
    const prior = [...bookNights];
    const out = [];
    const bestTonight = Math.max(...batch.map((x) => x.pts));
    for (const e of batch) {
      for (const stat of NIGHT_STATS) {
        let hit = bestLevel(e, prior, stat, nightLevels(e));
        if (hit && hit.level.id === "pool-any" && e.pts < bestTonight) hit = bestLevel(e, prior, stat, nightLevels(e).slice(1));
        if (hit) out.push(nightLine(e, stat, hit));
      }
    }
    if (out.length) lines.nights[d] = out;
    bookNights.push(...batch);
    doneNights.add(d);
  }

  // milestones: all-time totals walked night by night through this season; announce new nights that
  // carry a franchise past a round 1,000
  const MILESTONE = 1000;
  const running = {};
  for (const [s, byCode] of Object.entries(hist.seasonTotals)) {
    if (s === season) continue;
    for (const [c, v] of Object.entries(byCode)) running[c] = (running[c] || 0) + v;
  }
  const milestones = {};
  const newDateSet = new Set(newDates);
  for (const d of [...new Set(nights.map((x) => x.date))].sort()) {
    const batch = nights.filter((x) => x.date === d);
    const before = { ...running };
    for (const e of batch) running[e.code] = (running[e.code] || 0) + e.pts;
    if (!newDateSet.has(d)) continue;
    for (const e of batch) {
      const from = Math.floor((before[e.code] || 0) / MILESTONE), to = Math.floor(running[e.code] / MILESTONE);
      for (let m = from + 1; m <= to; m++) {
        const mark = m * MILESTONE;
        const already = Object.keys(running).filter((c) => c !== e.code && (before[c] || 0) >= mark).sort((x, y) => running[y] - running[x]);
        const sameNight = batch.filter((x) => x.code !== e.code && (before[x.code] || 0) < mark && running[x.code] >= mark).map((x) => x.code);
        (milestones[d] = milestones[d] || []).push(milestoneLine(e.code, mark, d, already, sameNight));
      }
    }
  }

  // players: franchise scoring leaders, the pool's single-franchise leader, drafted-player milestones
  const ph = loadPlayerHistory();
  const donePlayerNights = new Set(state.playerNights || []);
  let playerOut = { lines: [], newDates: [] };
  if (ph) {
    const pnights = currentPlayerNights(season, teamCode, today);
    playerOut = playerChecks(ph, pnights, donePlayerNights, [...new Set(Object.values(teamCode).filter(Boolean))]);
    for (const d of playerOut.newDates) donePlayerNights.add(d);
  } else log("No data/player-history.json: player checks skipped.");

  // prospects
  const pros = loadJson("prospect-history.json");
  let prosOut = { nightLines: {}, periodLines: {}, newNights: [], newPeriods: [] };
  if (pros) {
    const periodsFinal = [...donePeriods].filter((k) => k.startsWith(season + "|P")).map((k) => Number(k.split("|P")[1]));
    prosOut = prospectChecks(pros, loadJson("prospect-nights.json"), currentPlayerNights(season, teamCode, today), season, periodsFinal, state);
  } else log("No data/prospect-history.json: prospect checks skipped.");
  const doneProsNights = new Set([...(state.prospectNights || []), ...prosOut.newNights]);
  const doneProsPeriods = new Set([...(state.prospectPeriods || []), ...prosOut.newPeriods]);

  const paras = [];
  const periodNums = [...new Set([...Object.keys(lines.periods), ...Object.keys(prosOut.periodLines)].map(Number))].sort((a, b) => a - b);
  for (const n of periodNums) {
    const ls = [...(lines.periods[n] || []), ...(prosOut.periodLines[n] || [])];
    if (ls.length) paras.push(`*Period ${n} is final.*`, ...ls);
  }
  for (const [d, ls] of Object.entries(lines.nights)) paras.push(...ls);
  for (const d of Object.keys(milestones).sort()) paras.push(...milestones[d]);
  paras.push(...playerOut.lines);
  for (const d of Object.keys(prosOut.nightLines).sort()) paras.push(...prosOut.nightLines[d]);

  const nothingNew = !newPeriodNums.length && !newDates.length && !playerOut.newDates.length && !prosOut.newNights.length && !prosOut.newPeriods.length;
  if (nothingNew) { log("Nothing newly final."); return; }
  log(`Checked: ${newPeriodNums.map((n) => `Period ${n}`).concat(newDates).join(", ")}`);
  if (playerOut.newDates.length) log(`Player checks: ${playerOut.newDates.join(", ")}`);

  let posted = false;
  if (paras.length) {
    const text = paras.join("\n\n");
    log("\n" + text + "\n");
    if (!SEED) posted = await slack(text);
  } else log("No records.");

  // state moves on only when the post went out (or there was nothing to post, or it's a seed)
  const save = SEED || (!NO_SLACK && !TEST && (posted || !paras.length));
  if (save) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), periods: [...donePeriods].sort(), nights: [...doneNights].sort(), playerNights: [...donePlayerNights].sort(), prospectNights: [...doneProsNights].sort(), prospectPeriods: [...doneProsPeriods].sort() }, null, 1));
    log(`State saved (${path.relative(ROOT, STATE_FILE)}).`);
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });

// Every record set or tied in one finished period. Teams in the same period are checked against the book
// as it stood before the period, but a pool record only goes to the period's best: if a rival did better
// in this same period, the lesser team can still hold a franchise record, not a pool one.
function periodRecords(batch, prior) {
  const out = [];
  for (const e of batch) {
    for (const stat of PERIOD_STATS) {
      const beaten = batch.some((x) => x !== e && stat.dir * (stat.val(x) - stat.val(e)) > EPS);
      const levels = periodLevels(e).filter((l) => !(beaten && l.id.startsWith("pool")));
      const hit = bestLevel(e, prior, stat, levels);
      if (hit) out.push(periodLine(e, stat, hit));
    }
  }
  return out;
}
