// ============================================================
// PROJECTION REPORT: actual vs projected vs optimal, and where the period ends up
// ============================================================
// Pure points, per franchise, for the current scoring period:
//
//   TO DATE (through last night)
//     Act   points scored by the Active lineup
//     Prj   what F2's projections expected from that lineup over the games its teams have played
//     Opt   the best legal locked lineup in hindsight: the top 15 F + 4 D from the roster (Active + Reserve)
//           by points this period
//     GP    games played by Active skaters
//     GR    games remaining for Active skaters (their NHL teams' games from today to the period's end)
//
//   PROJECTED FINISH, three ways, each as a standings list:
//     Pace  Act + (Act / GP) x GR                  keep scoring at this period's rate
//     Proj  Act + sum of projected ppg x games remaining, Active lineup as locked
//     Opt   the best locked lineup for the whole period: top 15 F + 4 D by
//           (points so far this period + projected ppg x games remaining)
//
// Used two ways:
//   - nightly-report.js adds it under Lisa's nightly table (buildProjection)
//   - on its own, Lisa's Sunday-morning report:   node src/projection-report.js [--date YYYY-MM-DD] [--no-slack]
//     (--date = the last night to count; default yesterday, Pacific)
//
// Data:
//   F2    /api/league (periods, teams), /api/teams/{id}/roster?rcp=N (the period's locked roster: status,
//         F/D, NHL team), /api/players?status=ROSTERED (projected points and games -> projected ppg)
//   repo  data/nightly-report/*.json: each night's Active points (teams[].scored), Active GP (teams[].gp),
//         and per player points: players (Active) and bench (Reserve / Minors / IR)
//   NHL   api-web.nhle.com/v1/schedule/{date}: every regular-season game, for games played / remaining
//
// Env (standalone):
//   F2_BASE, F2_USER, F2_PASSWORD
//   SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_USERNAME (default "Lisa Turtle"), SLACK_ICON (default ":nail_care:")
//   ACTIVE_F, ACTIVE_D                default 15 and 4 (the Active lineup's forward / defence slots)
//   NIGHTLY_REPORT_DIR                default data/nightly-report
//   FRANCHISE_CODES                   optional JSON override of franchise -> initialism
// ============================================================

const fs = require("fs");
const path = require("path");

const TZ = "America/Vancouver";
const NHL = "https://api-web.nhle.com/v1";
const ROOT = path.join(__dirname, "..");
const REPORT_DIR = process.env.NIGHTLY_REPORT_DIR || path.join(ROOT, "data", "nightly-report");
const SLOTS_F = Number(process.env.ACTIVE_F || 15);
const SLOTS_D = Number(process.env.ACTIVE_D || 4);
const CODES = Object.assign({ brian: "BEW", chris: "PWN", graeme: "GDD", jason: "JGC", matt: "MPP", richie: "RMS" },
  JSON.parse(process.env.FRANCHISE_CODES || "{}"));
const initialism = (t) => CODES[t.franchise] || (t.name || t.id).slice(0, 3).toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ymdInTz = (d, tz = TZ) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const pretty = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

// ---- NHL schedule: { "YYYY-MM-DD": [ "EDM", "CGY", ... ] } (teams playing that day, regular season) ----
async function schedule(from, to) {
  const out = {};
  for (let d = from; d <= to; d = addDays(d, 7)) {
    const r = await fetch(`${NHL}/schedule/${d}`);
    if (!r.ok) throw new Error(`NHL schedule ${d}: HTTP ${r.status}`);
    const j = await r.json();
    for (const day of j.gameWeek || []) {
      if (day.date < from || day.date > to) continue;
      out[day.date] = out[day.date] || [];
      for (const g of day.games || []) {
        if (g.gameType !== 2) continue;
        out[day.date].push(g.awayTeam.abbrev, g.homeTeam.abbrev);
      }
    }
    await sleep(100);
  }
  return out;
}
function gamesFor(sched, from, to) {                       // { team: games } over [from, to]
  const n = {};
  for (const [d, teams] of Object.entries(sched)) if (d >= from && d <= to) for (const t of teams) n[t] = (n[t] || 0) + 1;
  return n;
}

// ---- the best locked lineup: top SLOTS_F forwards + SLOTS_D defence by value ----
function bestLineup(players, value) {
  const by = (pos) => players.filter((p) => p.pos === pos).map(value).sort((a, b) => b - a);
  const sum = (a, n) => a.slice(0, n).reduce((s, v) => s + v, 0);
  return sum(by("F"), SLOTS_F) + sum(by("D"), SLOTS_D);
}

// ---- the report ------------------------------------------------------------------------------------------
// f2: async (path) => json (already signed in). asOf: the last night to count (YYYY-MM-DD).
async function buildProjection({ f2, league, asOf }) {
  const period = (league.rcps || []).find((r) => r.number >= 1 && r.start_date <= asOf && asOf <= r.end_date)
    || (league.rcps || []).find((r) => r.number >= 1 && r.start_date === addDays(asOf, 1));
  if (!period) return null;
  const tomorrow = addDays(asOf, 1);
  const lastCounted = asOf < period.start_date ? null : asOf;          // before the period's first night, nothing to date

  // projected ppg, every rostered player
  const proj = {};
  const pl = await f2(`/api/players?status=ROSTERED&size=2000`);
  for (const p of pl.players || []) proj[p.id] = p.proj_fpts && p.proj_gp ? p.proj_fpts / p.proj_gp : 0;

  // the period's nights so far, from the nightly files
  const nights = [];
  if (lastCounted && fs.existsSync(REPORT_DIR)) {
    for (const f of fs.readdirSync(REPORT_DIR).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
      const r = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), "utf8"));
      if (r.period === period.number && r.date >= period.start_date && r.date <= lastCounted) nights.push(r);
    }
  }
  const missingGp = nights.some((r) => Object.values(r.teams || {}).some((t) => t.gp == null));

  const sched = await schedule(period.start_date, period.end_date);
  const played = lastCounted ? gamesFor(sched, period.start_date, lastCounted) : {};
  const remaining = gamesFor(sched, tomorrow > period.start_date ? tomorrow : period.start_date, period.end_date);

  const rows = [];
  for (const t of league.teams) {
    const roster = (await f2(`/api/teams/${t.id}/roster?rcp=${period.number}`)).players || [];
    const pts = {};                                                    // this period's points per player, Active or not
    let act = 0, gp = 0;
    for (const r of nights) {
      const tt = (r.teams || {})[t.id] || {};
      act += tt.scored || 0;
      gp += tt.gp || 0;
      for (const [pid, p] of Object.entries({ ...(r.players || {}), ...(r.bench || {}) })) if (p.team === t.id) pts[pid] = (pts[pid] || 0) + p.pts;
    }
    const skaters = roster.filter((p) => p.pos === "F" || p.pos === "D");
    const active = skaters.filter((p) => p.status === "ACTIVE");
    const pool = skaters.filter((p) => p.status === "ACTIVE" || p.status === "RESERVE");
    const gr = active.reduce((s, p) => s + (remaining[p.nhl_team] || 0), 0);
    const prjToDate = active.reduce((s, p) => s + (proj[p.id] || 0) * (played[p.nhl_team] || 0), 0);
    const optToDate = bestLineup(pool, (p) => pts[p.id] || 0);
    const pace = act + (gp ? (act / gp) * gr : 0);
    const prjEnd = act + active.reduce((s, p) => s + (proj[p.id] || 0) * (remaining[p.nhl_team] || 0), 0);
    const optEnd = bestLineup(pool, (p) => (pts[p.id] || 0) + (proj[p.id] || 0) * (remaining[p.nhl_team] || 0));
    rows.push({ code: initialism(t), act, prjToDate, optToDate, gp, gr, pace, prjEnd, optEnd });
  }
  return { period, asOf: lastCounted, rows, missingGp, daysLeft: Object.keys(sched).filter((d) => d >= tomorrow).length };
}

// ---- formatting (phones: ~30 monospace characters) ------------------------------------------------------
const r0 = (x) => String(Math.round(x));
function table(head, lines) {
  const all = [head, ...lines];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return "```\n" + all.map((r) => r.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join(" ")).join("\n") + "\n```";
}

// the report's day is the morning after asOf: on the period's last day (or after it) it's the
// "last day of period" report, otherwise "mid-period"
function reportTitle(p) {
  const day = addDays(p.asOf || addDays(p.period.start_date, -1), 1);
  return `F2 stats department: ${day >= p.period.end_date ? "last day of period" : "mid-period"} report (Period ${p.period.number})`;
}

function formatProjection(p, { title = true } = {}) {
  if (!p) return "";
  const out = [];
  if (title) out.push(`*${reportTitle(p)}*`);
  if (p.asOf) {
    out.push(`To date, through ${pretty(p.asOf)}`);
    const byAct = [...p.rows].sort((a, b) => b.act - a.act);
    out.push(table(["", "Points", "Prj", "Opt", "GP", "GR"], byAct.map((r) => [r.code, r0(r.act), r0(r.prjToDate), r0(r.optToDate), r.gp, r.gr])));
  } else {
    out.push(`Period ${p.period.number} starts ${pretty(p.period.start_date)}.`);
  }
  out.push(`Projected finish, ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`);
  // ordered by Pace; each franchise's Projected and Optimal finish on the same line
  const byPace = [...p.rows].sort((a, b) => b.pace - a.pace);
  out.push(table(["", "", "Pace", "Projected", "Optimal"], byPace.map((r, i) => [`${i + 1}.`, r.code, r0(r.pace), r0(r.prjEnd), r0(r.optEnd)])));
  if (p.missingGp) out.push("_Some nights have no GP yet, so Pace is short: re-run the nightly backfill._");
  return out.join("\n");
}

module.exports = { buildProjection, formatProjection };

// ---- standalone: Lisa's Sunday report ----------------------------------------------------------------
if (require.main === module) {
  const ARGS = process.argv.slice(2);
  const arg = (k) => { const i = ARGS.indexOf(k); return i >= 0 ? ARGS[i + 1] : null; };
  const NO_SLACK = ARGS.includes("--no-slack");
  const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(2); } return v; };
  const F2_BASE = need("F2_BASE").replace(/\/+$/, "");
  const F2_USER = need("F2_USER"), F2_PASSWORD = need("F2_PASSWORD");
  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "", SLACK_CHANNEL = process.env.SLACK_CHANNEL || "";
  const SLACK_USERNAME = process.env.SLACK_USERNAME || "Lisa Turtle", SLACK_ICON = process.env.SLACK_ICON || ":nail_care:";
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

  (async () => {
    const r = await fetch(`${F2_BASE}/door`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
      body: new URLSearchParams({ name: F2_USER, password: F2_PASSWORD }).toString(), redirect: "manual",
    });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""]) { const m = String(c).match(/^\s*([^=;\s]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    if (!Object.keys(jar).length) throw new Error(`F2 sign-in failed (HTTP ${r.status})`);
    const f2 = async (p) => {
      const x = await fetch(F2_BASE + p, { headers: { Cookie: cookie() } });
      if (!x.ok || !(x.headers.get("content-type") || "").includes("json")) throw new Error(`F2 ${p}: HTTP ${x.status}`);
      return x.json();
    };
    const league = await f2("/api/league");
    const asOf = arg("--date") || addDays(ymdInTz(new Date()), -1);
    const p = await buildProjection({ f2, league, asOf });
    if (!p) { console.log(`No scoring period around ${asOf}.`); return; }
    const text = formatProjection(p);
    console.log("\n" + text);
    if (NO_SLACK || !SLACK_TOKEN || !SLACK_CHANNEL) { console.log("(not posting to Slack)"); return; }
    const s = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false, username: SLACK_USERNAME,
        ...(SLACK_ICON.startsWith("http") ? { icon_url: SLACK_ICON } : { icon_emoji: SLACK_ICON }) }),
    });
    const o = await s.json();
    if (!o.ok) throw new Error(`Slack: ${o.error}`);
  })().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
}
