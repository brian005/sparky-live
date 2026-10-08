// ============================================================
// NIGHTLY REPORT: who scored, who left points on the bench
// ============================================================
// For one night's NHL games (default: yesterday, Pacific), per franchise:
//   Poss       points by EVERY rostered player (Active + Reserve + Minors; prospects sit in Minors)
//   Scored     points by Active players (what actually counts)
//   Rec        Scored / Poss
// and, of the Scored points:
//   G, A, 1stA (primary), 2ndA (secondary), Prim (G + 1stA), PP% (power-play share), EN% (empty-net share)
// plus the same table season-to-date, summed from the nightly files this job keeps.
//
// Data:
//   NHL   api-web.nhle.com/v1/score/{date}: every goal with its scorer, assists IN ORDER (first =
//         primary), strength (ev/pp/sh) and goalModifier (empty-net). Shootout goals are skipped.
//   F2    the roster for the scoring period that date belongs to (what scoring itself uses), and each
//         player's NHL id from /api/players/{id}, cached in data/nhl-ids.json (only new players are looked up).
//
// Usage:
//   node src/nightly-report.js                    # yesterday, post to Slack
//   node src/nightly-report.js --date 2026-10-07  # a specific night
//   node src/nightly-report.js --backfill         # every night from the season's first period to yesterday
//                                                 # (writes the nightly files; posts only the last night)
//   node src/nightly-report.js --no-slack         # print only
//
// Env:
//   F2_BASE, F2_USER, F2_PASSWORD     sparkypool.ca sign-in (same as the janitor)
//   SLACK_BOT_TOKEN, SLACK_CHANNEL    SparkyBot and where to post
//   NIGHTLY_REPORT_DIR                default data/nightly-report
//   NHL_ID_CACHE                      default data/nhl-ids.json
// ============================================================

const fs = require("fs");
const path = require("path");

const ARGS = process.argv.slice(2);
const arg = (k) => { const i = ARGS.indexOf(k); return i >= 0 ? ARGS[i + 1] : null; };
const NO_SLACK = ARGS.includes("--no-slack");
const BACKFILL = ARGS.includes("--backfill");
const TZ = "America/Vancouver";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(2); } return v; };
const F2_BASE = need("F2_BASE").replace(/\/+$/, "");
const F2_USER = need("F2_USER");
const F2_PASSWORD = need("F2_PASSWORD");
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "";
const ROOT = path.join(__dirname, "..");
const REPORT_DIR = process.env.NIGHTLY_REPORT_DIR || path.join(ROOT, "data", "nightly-report");
const ID_CACHE = process.env.NHL_ID_CACHE || path.join(ROOT, "data", "nhl-ids.json");
const NHL = "https://api-web.nhle.com/v1";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- dates -------------------------------------------------------------------------
function ymdInTz(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const yesterday = () => addDays(ymdInTz(new Date()), -1);
const pretty = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

// ---- F2 -------------------------------------------------------------------------------
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

// the period a date's games score in (F2's own rule: a period runs start_date..end_date)
function periodFor(league, ymd) {
  return (league.rcps || []).find((r) => r.number >= 1 && r.start_date <= ymd && ymd <= r.end_date) || null;
}

// rosters for a period: { nhlId: { team, teamName, status, name } }
const rosterCache = {};
async function ownership(league, period, ids) {
  if (rosterCache[period.number]) return rosterCache[period.number];
  const own = {};
  const missing = [];
  for (const t of league.teams) {
    const r = await f2(`/api/teams/${t.id}/roster?rcp=${period.number}`);
    for (const p of r.players || []) {
      if (!ids[p.id]) missing.push(p.id);
      own[p.id] = { team: t.id, teamName: t.name, franchise: t.franchise, status: p.status, name: p.name };
    }
  }
  // NHL ids for players we haven't seen: one lookup each, then cached for good
  for (const fid of [...new Set(missing)]) {
    try {
      const d = await f2(`/api/players/${fid}`);
      ids[fid] = d.nhl_id || null;
    } catch (e) { ids[fid] = null; log(`  no NHL id for ${fid}: ${e.message}`); }
    await sleep(100);
  }
  const byNhl = {};
  for (const [fid, o] of Object.entries(own)) if (ids[fid]) byNhl[ids[fid]] = { ...o, fantraxId: fid };
  rosterCache[period.number] = byNhl;
  return byNhl;
}

// ---- NHL ------------------------------------------------------------------------------------
async function nightGoals(ymd) {
  const r = await fetch(`${NHL}/score/${ymd}`);
  if (!r.ok) throw new Error(`NHL score ${ymd}: HTTP ${r.status}`);
  const j = await r.json();
  const games = (j.games || []).filter((g) => g.gameDate === ymd);
  const notFinal = games.filter((g) => !["OFF", "FINAL"].includes(g.gameState));
  const goals = [];
  for (const g of games) {
    for (const goal of g.goals || []) {
      if ((goal.periodDescriptor || {}).periodType === "SO") continue;      // shootout goals aren't points
      goals.push({
        game: `${g.awayTeam.abbrev}@${g.homeTeam.abbrev}`,
        scorer: goal.playerId,
        a1: (goal.assists || [])[0] ? goal.assists[0].playerId : null,
        a2: (goal.assists || [])[1] ? goal.assists[1].playerId : null,
        pp: goal.strength === "pp",
        en: goal.goalModifier === "empty-net",
      });
    }
  }
  return { games: games.length, notFinal: notFinal.map((g) => `${g.awayTeam.abbrev}@${g.homeTeam.abbrev} (${g.gameState})`), goals };
}

// ---- tally ------------------------------------------------------------------------------------
const blank = () => ({ eligible: 0, scored: 0, g: 0, a: 0, a1: 0, a2: 0, pp: 0, en: 0 });

function tally(goals, own, teams) {
  const out = Object.fromEntries(teams.map((t) => [t.id, blank()]));
  const credit = (nhlId, kind, goal) => {
    const o = own[nhlId];
    if (!o || !out[o.team]) return;
    const t = out[o.team];
    t.eligible += 1;
    if (o.status !== "ACTIVE") return;
    t.scored += 1;
    if (kind === "G") t.g += 1;
    else { t.a += 1; if (kind === "A1") t.a1 += 1; else t.a2 += 1; }
    if (goal.pp) t.pp += 1;
    if (goal.en) t.en += 1;
  };
  for (const goal of goals) {
    credit(goal.scorer, "G", goal);
    if (goal.a1) credit(goal.a1, "A1", goal);
    if (goal.a2) credit(goal.a2, "A2", goal);
  }
  return out;
}

function add(into, from) { for (const k of Object.keys(into)) into[k] += from[k] || 0; return into; }

// ---- one night ---------------------------------------------------------------------------------
async function runNight(league, ymd, ids) {
  const period = periodFor(league, ymd);
  if (!period) return { date: ymd, skipped: "no scoring period that day" };
  const night = await nightGoals(ymd);
  if (!night.games) return { date: ymd, period: period.number, games: 0, teams: {} };
  const own = await ownership(league, period, ids);
  const teams = tally(night.goals, own, league.teams);
  const rec = { date: ymd, period: period.number, games: night.games, goals: night.goals.length, notFinal: night.notFinal, teams };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, `${ymd}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

function seasonToDate(league, uptoYmd) {
  const first = (league.rcps || []).filter((r) => r.number >= 1).sort((a, b) => a.number - b.number)[0];
  const totals = Object.fromEntries(league.teams.map((t) => [t.id, blank()]));
  let nights = 0;
  for (const f of fs.existsSync(REPORT_DIR) ? fs.readdirSync(REPORT_DIR) : []) {
    const ymd = f.replace(/\.json$/, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || (first && ymd < first.start_date) || ymd > uptoYmd) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), "utf8"));
    if (!rec.teams || !rec.games) continue;
    nights += 1;
    for (const [tid, t] of Object.entries(rec.teams)) if (totals[tid]) add(totals[tid], t);
  }
  return { nights, totals };
}

// ---- Slack ----------------------------------------------------------------------------------------
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");

function table(teams, rows) {
  const head = ["", "Poss", "Scored", "Rec", "G", "A", "1stA", "2ndA", "Prim", "PP%", "EN%"];
  const lines = rows.map(([tid, t]) => [
    (teams.find((x) => x.id === tid) || {}).short || tid, t.eligible, t.scored, pct(t.scored, t.eligible),
    t.g, t.a, t.a1, t.a2, t.g + t.a1, pct(t.pp, t.scored), pct(t.en, t.scored),
  ].map(String));
  const all = [head, ...lines];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ")).join("\n");
}

const sortRows = (obj) => Object.entries(obj).sort((a, b) => b[1].scored - a[1].scored || b[1].eligible - a[1].eligible);

function compose(league, rec, std) {
  const teams = league.teams.map((t) => ({ id: t.id, short: initialism(t) }));
  const out = [];
  if (!rec.games) return `*Nightly report: ${pretty(rec.date)}*\nNo NHL games.`;
  out.push(`*Nightly report: ${pretty(rec.date)}* · ${rec.games} game${rec.games === 1 ? "" : "s"}, ${rec.goals} goals · Period ${rec.period}`);
  if ((rec.notFinal || []).length) out.push(`:warning: not final yet: ${rec.notFinal.join(", ")}`);
  out.push("```" + table(teams, sortRows(rec.teams)) + "```");
  // the night's story in one line: most points left on the bench
  const bench = sortRows(rec.teams).map(([tid, t]) => [tid, t.eligible - t.scored]).sort((a, b) => b[1] - a[1])[0];
  if (bench && bench[1] > 0) out.push(`Most left on the bench: *${(teams.find((x) => x.id === bench[0]) || {}).short}*, ${bench[1]} point${bench[1] === 1 ? "" : "s"} from Reserve and Minors.`);
  if (std.nights > 1) {
    out.push(`*Season to date* (${std.nights} game nights)`);
    out.push("```" + table(teams, sortRows(std.totals)) + "```");
  }
  out.push("_Poss = points by everyone rostered (Active, Reserve, Minors). Scored = Active only. Rec = Scored / Poss. Breakdown is of Scored: 1stA/2ndA = primary/secondary assists, Prim = G + 1stA._");
  return out.join("\n");
}

// League convention: 3-letter initialism starting with the owner's first initial (BEW, PWN, ...).
// F2's short_name is the owner's nickname, so map franchise -> code here, overridable by env.
const CODES = Object.assign({ brian: "BEW", chris: "PWN", graeme: "GDD", jason: "JGC", matt: "MPP", richie: "RMS" },
  JSON.parse(process.env.FRANCHISE_CODES || "{}"));
function initialism(t) { return CODES[t.franchise] || (t.name || t.id).slice(0, 3).toUpperCase(); }

async function slack(text) {
  if (NO_SLACK || !SLACK_TOKEN || !SLACK_CHANNEL) { log("(not posting to Slack)"); return; }
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
  });
  const o = await r.json();
  if (!o.ok) throw new Error(`Slack: ${o.error}`);
}

// ---- main ----------------------------------------------------------------------------------------
(async () => {
  await f2Login();
  const league = await f2("/api/league");
  const ids = fs.existsSync(ID_CACHE) ? JSON.parse(fs.readFileSync(ID_CACHE, "utf8")) : {};
  const last = arg("--date") || yesterday();

  let dates = [last];
  if (BACKFILL) {
    const first = (league.rcps || []).filter((r) => r.number >= 1).sort((a, b) => a.number - b.number)[0];
    dates = [];
    for (let d = first.start_date; d <= last; d = addDays(d, 1)) dates.push(d);
  }

  let rec = null;
  for (const d of dates) {
    rec = await runNight(league, d, ids);
    log(`${d}: ${rec.skipped || `${rec.games} games, ${rec.goals || 0} goals`}`);
    await sleep(200);
  }

  fs.mkdirSync(path.dirname(ID_CACHE), { recursive: true });
  fs.writeFileSync(ID_CACHE, JSON.stringify(ids, null, 1));
  const unmapped = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
  if (unmapped.length) log(`Players with no NHL id (not counted): ${unmapped.join(", ")}`);

  if (rec.skipped) { log(`Nothing to post: ${rec.skipped}`); return; }
  const text = compose(league, rec, seasonToDate(league, last));
  log("\n" + text);
  await slack(text);
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
