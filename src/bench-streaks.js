// ============================================================
// BENCH STREAKS: healthy players stuck on the bench, the night before lock
// ============================================================
// Posted by "Zack Morris" to #sparky at ~6 PM Pacific the evening before the next period locks.
// Lists every rostered, NON-INJURED player who has sat in Reserve for 2+ periods in a row, counting
// back from the NEXT period's lineup as it's currently set (so the post is a nudge: owners still have
// until lock to change it).
//
// Example: posted Sun Oct 11 (Period 2 locks Mon Oct 12): a player in Reserve for Period 1 AND in
// Reserve in the preset Period 2 lineup shows a 2-period streak.
//
// Benched   = F2 status RESERVE. Minors (prospects) and IR don't count and don't extend a streak.
// Injured   = in IR, or on ESPN's NHL injury list (any status, Day-to-Day included). That's the same
//             list F2 draws its injury flags from (engine/sparky/injuries.py), matched the same way:
//             folded name, NHL team when the name isn't unique.
// Streak    = consecutive periods in Reserve, counting back from the next period. It doesn't care which
//             team: a guy benched by one owner and then by the owner he was traded to keeps his streak.
//
// Data (F2):
//   GET /api/league                          periods (rcps: number, start_date, end_date, lock_ts), teams
//   GET /api/teams/{id}/roster?rcp=N         the ledger replayed through period N; for the next,
//                                            not-yet-locked period that's the lineup as preset right now
//
// When it posts: the workflow fires at 01:05 and 02:05 UTC (6 PM in both PDT and PST, cron is UTC and
// doesn't follow DST). The script posts only if it's 18:00-21:59 Pacific, the next period locks
// TOMORROW, and it hasn't already posted for that period (data/bench-streaks/p{N}.json). So one of the
// two fires posts, the other skips, and a failed first fire gets retried by the second.
//
// Usage:
//   node src/bench-streaks.js                 # scheduled behaviour (gated)
//   node src/bench-streaks.js --force         # skip the timing gate and the already-posted check
//   node src/bench-streaks.js --period 2      # treat period 2 as the "next" period (implies --force)
//   node src/bench-streaks.js --no-slack      # print only, write no marker
//
// Env:
//   F2_BASE, F2_USER, F2_PASSWORD     sparkypool.ca sign-in (same as the janitor)
//   SLACK_BOT_TOKEN, SLACK_CHANNEL    bot token (needs chat:write.customize) and where to post
//   SLACK_USERNAME                    default "Zack Morris"
//   SLACK_ICON                        emoji (":telephone_receiver:") or image URL; default ":telephone_receiver:"
//   MIN_STREAK                        default 2
//   POST_HOUR_FROM, POST_HOUR_TO      Pacific hour window for scheduled posts, default 18 and 21
//   BENCH_STREAK_DIR                  default data/bench-streaks
//   FRANCHISE_CODES                   optional JSON override of franchise -> initialism
// ============================================================

const fs = require("fs");
const path = require("path");

const ARGS = process.argv.slice(2);
const arg = (k) => { const i = ARGS.indexOf(k); return i >= 0 ? ARGS[i + 1] : null; };
const NO_SLACK = ARGS.includes("--no-slack");
const PERIOD_ARG = arg("--period") != null ? Number(arg("--period")) : null;
const FORCE = ARGS.includes("--force") || PERIOD_ARG != null;
const TZ = "America/Vancouver";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(2); } return v; };
const F2_BASE = need("F2_BASE").replace(/\/+$/, "");
const F2_USER = need("F2_USER");
const F2_PASSWORD = need("F2_PASSWORD");
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "";
const SLACK_USERNAME = process.env.SLACK_USERNAME || "Zack Morris";
const SLACK_ICON = process.env.SLACK_ICON || ":telephone_receiver:";
const MIN_STREAK = Number(process.env.MIN_STREAK || 2);
const HOUR_FROM = Number(process.env.POST_HOUR_FROM || 18);
const HOUR_TO = Number(process.env.POST_HOUR_TO || 21);
const ROOT = path.join(__dirname, "..");
const OUT_DIR = process.env.BENCH_STREAK_DIR || path.join(ROOT, "data", "bench-streaks");
const ESPN_INJURIES = "https://site.web.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- time (F2 stores lock_ts as naive Pacific time, so compare in that frame) ----------------
function pacificNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return { iso: `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`, ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(hour) };
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// a period with no lock_ts locks at 16:00 on its start date (F2's own fallback in ledger.replay)
const lockOf = (r) => r.lock_ts || `${r.start_date}T16:00:00`;
function prettyLock(iso) {
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  return `${day}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ---- F2 -------------------------------------------------------------------------------------
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

// ---- injuries (ESPN's list, matched like F2's injuries.py) --------------------------------------
const ESPN_ABBR = { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", UTAH: "UTA", VGS: "VGK" };
const fold = (s) => (s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\./g, "").replace(/-/g, " ").trim();

async function injuryList() {
  const r = await fetch(ESPN_INJURIES, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json" } });
  if (!r.ok) throw new Error(`ESPN injuries: HTTP ${r.status}`);
  const d = await r.json();
  const out = [];
  for (const team of d.injuries || []) {
    for (const inj of team.injuries || []) {
      const ath = inj.athlete || {};
      const club = ((ath.team || {}).abbreviation || "").toUpperCase();
      out.push({ name: fold(ath.displayName), club: ESPN_ABBR[club] || club, status: inj.status || "" });
    }
  }
  return out;
}

// { playerId: status } for the rostered players on ESPN's list
function injuredIds(list, players) {
  const byName = {};
  for (const p of players) (byName[fold(p.name)] = byName[fold(p.name)] || []).push(p);
  const hit = {};
  for (const inj of list) {
    const cands = byName[inj.name] || [];
    const pick = cands.find((c) => (c.nhl_team || "").toUpperCase() === inj.club) || (cands.length === 1 ? cands[0] : null);
    if (pick) hit[pick.id] = inj.status;
  }
  return hit;
}

// ---- streaks ------------------------------------------------------------------------------------
async function rostersFor(league, period) {
  // { playerId: { teamId, status, player } }
  const out = {};
  for (const t of league.teams) {
    const r = await f2(`/api/teams/${t.id}/roster?rcp=${period}`);
    for (const p of r.players || []) out[p.id] = { teamId: t.id, status: p.status, player: p };
    await sleep(100);
  }
  return out;
}

async function streaks(league, next) {
  const periods = [];
  for (let n = next; n >= 1; n--) periods.push(n);
  const byPeriod = {};
  for (const n of periods) { byPeriod[n] = await rostersFor(league, n); log(`  period ${n}: ${Object.keys(byPeriod[n]).length} rostered`); }

  const now = byPeriod[next];
  const rows = [];
  for (const [pid, cur] of Object.entries(now)) {
    if (cur.status !== "RESERVE") continue;
    let streak = 0;
    for (const n of periods) {
      const r = byPeriod[n][pid];
      if (!r || r.status !== "RESERVE") break;
      streak += 1;
    }
    if (streak >= MIN_STREAK) rows.push({ id: pid, teamId: cur.teamId, streak, p: cur.player });
  }
  return { rows, rostered: Object.values(now).map((x) => x.player) };
}

// ---- Slack ------------------------------------------------------------------------------------------
const CODES = Object.assign({ brian: "BEW", chris: "PWN", graeme: "GDD", jason: "JGC", matt: "MPP", richie: "RMS" },
  JSON.parse(process.env.FRANCHISE_CODES || "{}"));
const initialism = (t) => CODES[t.franchise] || (t.name || t.id).slice(0, 3).toUpperCase();

// ppg from this season's NHL points / games played; null when he hasn't played (sorts last)
const ppgOf = (p) => (p.season_gp ? (p.season_points || 0) / p.season_gp : null);
// F2 salaries are exact cap-hit dollars: 925000 -> "$0.9M"
const money = (s) => (s ? `$${(s / 1e6).toFixed(1)}M` : "$?");

function playerTag(p) {
  const ppg = ppgOf(p);
  return `${p.name} (${ppg == null ? "0 GP" : `${ppg.toFixed(2)} ppg`} @ ${money(p.salary)})`;
}

// One line per franchise: *PWN*: Shane Wright (0.60 ppg @ $0.9M), Dmitri Voronkov (0.33 ppg @ $4.2M)
// Players in descending ppg; franchises with the most benched first.
function compose(league, nextRcp, rows, skippedInjured) {
  const teams = Object.fromEntries(league.teams.map((t) => [t.id, initialism(t)]));
  const out = [];
  out.push(`*Time out.* Period ${nextRcp.number} locks ${prettyLock(lockOf(nextRcp))}. Healthy players benched ${MIN_STREAK}+ periods straight, counting Period ${nextRcp.number}'s lineup as it's set right now:`);
  if (!rows.length) {
    out.push("Nobody. Everyone's playing their guys.");
  } else {
    const byTeam = {};
    for (const r of rows) (byTeam[r.teamId] = byTeam[r.teamId] || []).push(r);
    const order = Object.keys(byTeam).sort((a, b) => byTeam[b].length - byTeam[a].length || teams[a].localeCompare(teams[b]));
    for (const tid of order) {
      const list = byTeam[tid].sort((a, b) => (ppgOf(b.p) ?? -1) - (ppgOf(a.p) ?? -1) || a.p.name.localeCompare(b.p.name));
      out.push(`*${teams[tid]}*: ${list.map((r) => playerTag(r.p)).join(", ")}`);
    }
  }
  if (skippedInjured) out.push(`_Left out: ${skippedInjured} benched player${skippedInjured === 1 ? "" : "s"} on the injury list._`);
  return out.join("\n");
}

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
  await f2Login();
  const league = await f2("/api/league");
  const rcps = (league.rcps || []).filter((r) => r.number >= 1).sort((a, b) => a.number - b.number);
  const now = pacificNow();

  const next = PERIOD_ARG != null ? rcps.find((r) => r.number === PERIOD_ARG) : rcps.find((r) => lockOf(r) > now.iso);
  if (!next) { log(PERIOD_ARG != null ? `F2 has no period ${PERIOD_ARG}` : "No upcoming lock this season."); return; }
  const marker = path.join(OUT_DIR, `p${next.number}.json`);

  if (!FORCE) {
    const lockDay = lockOf(next).slice(0, 10);
    if (lockDay !== addDays(now.ymd, 1)) { log(`Period ${next.number} locks ${lockOf(next)}, not tomorrow. Nothing to do.`); return; }
    if (now.hour < HOUR_FROM || now.hour > HOUR_TO) { log(`It's ${now.iso} Pacific, outside ${HOUR_FROM}:00-${HOUR_TO}:59. Nothing to do.`); return; }
    if (fs.existsSync(marker)) { log(`Already posted for Period ${next.number} (${path.relative(ROOT, marker)}).`); return; }
  }

  log(`Next lock: Period ${next.number} at ${lockOf(next)} (now ${now.iso} Pacific)`);
  const { rows, rostered } = await streaks(league, next.number);

  let inj = {};
  try { inj = injuredIds(await injuryList(), rostered); }
  catch (e) { log(`Injury list unavailable (${e.message}); posting without the injury filter.`); }
  const healthy = rows.filter((r) => !inj[r.id]);
  const skipped = rows.length - healthy.length;
  for (const r of rows.filter((x) => inj[x.id])) log(`  left out (injured: ${inj[r.id]}): ${r.p.name}`);

  const text = compose(league, next, healthy, skipped);
  log("\n" + text);
  const posted = await slack(text);

  if (posted) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({
      postedAt: now.iso, period: next.number, lock: lockOf(next), minStreak: MIN_STREAK,
      players: healthy.map((r) => ({ id: r.id, name: r.p.name, team: r.teamId, streak: r.streak })),
      leftOutInjured: rows.filter((r) => inj[r.id]).map((r) => ({ id: r.id, name: r.p.name, status: inj[r.id] })),
    }, null, 2));
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
