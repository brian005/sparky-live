// ============================================================
// F1 REPLICATE: mirror F2 (sparkypool.ca) rosters onto Fantrax
// ============================================================
// After a period locks on F2, this makes Fantrax's rosters for that
// period match F2's, using commissioner mode, then re-reads Fantrax to
// prove it and compares season standings between the two.
//
// Read side (F2):  GET {F2_BASE}/api/league                     -> periods, teams
//                  GET {F2_BASE}/api/teams/{id}/roster?rcp=N    -> the ledger replayed to period N
//                  GET {F2_BASE}/api/standings                  -> season points per team
// Write side (F1): POST /fxpa/req from a signed-in fantrax.com page, with the
//                  same method names and payloads Fantrax's own client sends
//                  (shapes read out of the frozen client in F2's fxpa_moves.py /
//                  fxpa_commish.py).
//
// F2 already uses Fantrax's own ids (team ids, scorerIds), so no name matching.
//
// Order per run: commish trades -> commish claims/drops -> lineups -> verify -> standings.
//
// Usage:
//   node src/f1-replicate.js                  # DRY RUN of the janitor sweep: every locked period, plan only
//   node src/f1-replicate.js --apply          # the janitor: fix every locked period, oldest to newest
//   node src/f1-replicate.js --latest         # only the newest locked period
//   node src/f1-replicate.js --period 2       # only F2 period 2
//   node src/f1-replicate.js --apply --force  # skip the too-many-changes guard
//   node src/f1-replicate.js --verify-only    # diff + standings, no writes
//
// Env:
//   FANTRAX_USERNAME (or FANTRAX_EMAIL), FANTRAX_PASSWORD   commissioner Fantrax login (required)
//   FANTRAX_LEAGUE_ID                 Fantrax league id (required)
//   F2_BASE                           e.g. https://sparkypool.ca (required)
//   F2_USER, F2_PASSWORD              the sparkypool.ca sign-in (Name / Password on its front page)
//   F2_TOKEN                          optional X-Token header instead of the sign-in
//   SLACK_BOT_TOKEN, SLACK_CHANNEL    optional; posts the report on --apply / --verify-only
//   MAX_MEMBERSHIP_CHANGES            guard, default 12 (trades+claims+drops per run)
//   F1_REPORT_DIR                     default data/f1-replicate
//   HEADLESS                          "false" to watch the browser locally
//   QUIET                             "1": post to Slack only on a fresh lock, a change, a failure or a points mismatch
//   SKIP_POINTS                       "1": skip the season-points comparison
// ============================================================

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const fs = require("fs");
const path = require("path");

// ---- config ----------------------------------------------------------------
const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const VERIFY_ONLY = ARGS.includes("--verify-only");
const FORCE = ARGS.includes("--force");
const LATEST_ONLY = ARGS.includes("--latest");
const PERIOD_ARG = (() => { const i = ARGS.indexOf("--period"); return i >= 0 ? parseInt(ARGS[i + 1], 10) : null; })();

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(2); } return v; };
const FX_EMAIL = process.env.FANTRAX_EMAIL || need("FANTRAX_USERNAME");   // Sparky Live calls it FANTRAX_USERNAME
const FX_PASSWORD = need("FANTRAX_PASSWORD");
const LEAGUE = need("FANTRAX_LEAGUE_ID");
const F2_BASE = need("F2_BASE").replace(/\/+$/, "");
const F2_TOKEN = process.env.F2_TOKEN || "";
const F2_USER = process.env.F2_USER || "";
const F2_PASSWORD = process.env.F2_PASSWORD || process.env.F2_PIN || "";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "";
const MAX_CHANGES = parseInt(process.env.MAX_MEMBERSHIP_CHANGES || "12", 10);
const REPORT_DIR = process.env.F1_REPORT_DIR || path.join(__dirname, "..", "data", "f1-replicate");
const HEADLESS = process.env.HEADLESS !== "false";
const QUIET = process.env.QUIET === "1";          // scheduled runs: Slack only when something happened
const SKIP_POINTS = process.env.SKIP_POINTS === "1";  // optional: skip the points comparison
const FX = "https://www.fantrax.com";
const TZ = "America/Vancouver";

// Fantrax ids (F2's fxpa.py: STATUS_ID / POS_ID)
const STATUS_ID = { ACTIVE: "1", RESERVE: "2", IR: "3", MINORS: "9" };
const ID_STATUS = Object.fromEntries(Object.entries(STATUS_ID).map(([k, v]) => [v, k]));
const POS_ID = { F: "207", D: "202", G: "201" };
const ID_POS = Object.fromEntries(Object.entries(POS_ID).map(([k, v]) => [v, k]));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- F2 ----------------------------------------------------------------------
// The live site (unlike the copy Chris zipped) has a front door on every path: unsigned requests
// get 401 {"error":"sign in"}, and the sign-in page is a plain form POSTing name + password to
// /door. Sign in there once per run and carry every cookie it sets.
const jar = {};
const f2Cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

function takeCookies(r) {
  const list = r.headers.getSetCookie ? r.headers.getSetCookie() : (r.headers.get("set-cookie") || "").split(/,(?=\s*[^;,=\s]+=)/);
  for (const c of list) {
    const m = String(c).match(/^\s*([^=;\s]+)=([^;]*)/);
    if (m) jar[m[1]] = m[2];
  }
}

async function f2Login() {
  if (!F2_USER || !F2_PASSWORD) throw new Error("F2 needs F2_USER and F2_PASSWORD (the sparkypool.ca sign-in)");
  const r = await fetch(`${F2_BASE}/door`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: new URLSearchParams({ name: F2_USER, password: F2_PASSWORD }).toString(),
    redirect: "manual",
  });
  takeCookies(r);
  if (!Object.keys(jar).length) throw new Error(`F2 sign-in at /door failed (HTTP ${r.status}): no cookie set. Check F2_USER / F2_PASSWORD`);
  const check = await fetch(`${F2_BASE}/api/league`, { headers: { Cookie: f2Cookie() } });   // prove it took
  if (check.status === 401) throw new Error("F2 sign-in at /door did not take (still 401). Check F2_USER / F2_PASSWORD");
  log("F2: signed in as", F2_USER);
}

async function f2(pathname) {
  const headers = {};
  if (F2_TOKEN) headers["X-Token"] = F2_TOKEN;
  if (Object.keys(jar).length) headers.Cookie = f2Cookie();
  const r = await fetch(F2_BASE + pathname, { headers });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok || !ct.includes("json")) throw new Error(`F2 ${pathname}: HTTP ${r.status} ${ct.includes("json") ? "" : "(not JSON: sign-in page? set F2_USER/F2_PASSWORD)"} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// ---- identity: ID first, name as the fallback ------------------------------------
// F2 mostly uses Fantrax's own scorerIds, but not always: draftees Fantrax had not loaded when F2
// took them get F2's own ids ("dr2026-23"), and spellings drift (Egor/Yegor, JP/J.P.).
// Every F2 player is resolved to exactly one Fantrax player before anything is diffed:
//   1. ID on a Fantrax roster, last names agree           -> that player
//   2. ID found in Fantrax's pool search, last names agree -> that player
//   3. otherwise, name fallback in the pool:
//        exactly one exact full-name match                 -> that player
//        else exactly one same-last-name + same-NHL-team   -> that player
//   4. anything else (no match, two candidates, ID matches a different name) -> UNRESOLVED:
//      skipped, drops on that team held, and named in Slack for a hand fix.
// Never a guess: a fallback acts only on a single unambiguous candidate.
const normName = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const flat = (s) => normName(s).replace(/ /g, "");
const lastName = (s) => normName(s).split(" ").pop();
const sameLast = (a, b) => lastName(a) === lastName(b);

const f2Has = (f2r, id) => Object.values(f2r).some((r) => r[id]);

async function searchPool(fx, name) {
  const d = await fx("getPlayerStats", { searchName: lastName(name), statusOrTeamFilter: "ALL" });
  return (d.statsTable || []).map((r) => r.scorer || {}).filter((s) => s.scorerId)
    .map((s) => ({ id: s.scorerId, name: s.name, nhl: s.teamShortName || "" }));
}

async function resolveIds(fx, f2r, fxr) {
  const fxAll = {};
  for (const r of Object.values(fxr)) for (const [pid, p] of Object.entries(r)) fxAll[pid] = p;
  const aliases = [], unresolved = [], cache = {};
  for (const [tid, roster] of Object.entries(f2r)) {
    for (const pid of Object.keys(roster)) {
      const want = roster[pid];
      let hit = null, why = "";
      if (fxAll[pid]) {                                                    // 1
        if (sameLast(fxAll[pid].name, want.name)) continue;                // the normal case: nothing to do
        why = `ID ${pid} is ${fxAll[pid].name} on Fantrax`;
      }
      if (!why) {
        const pool = cache[lastName(want.name)] || (cache[lastName(want.name)] = await searchPool(fx, want.name));
        const byId = pool.find((c) => c.id === pid);
        if (byId) {                                                        // 2
          if (sameLast(byId.name, want.name)) continue;
          why = `ID ${pid} is ${byId.name} on Fantrax`;
        } else {                                                           // 3
          // narrowing tests, strongest first; the first that leaves exactly one candidate wins
          const last = pool.filter((c) => sameLast(c.name, want.name));
          const tests = [
            pool.filter((c) => flat(c.name) === flat(want.name)),                                  // exact full name
            last.filter((c) => (fxr[tid] || {})[c.id] && !f2Has(f2r, c.id)),                       // already on this fantasy team on Fantrax, unclaimed on F2
            last.filter((c) => want.nhl && c.nhl === want.nhl),                                    // same NHL club
          ];
          hit = (tests.find((t) => t.length === 1) || [])[0] || null;
          if (!hit) {
            const n = Math.max(...tests.map((t) => t.length), last.length);
            why = n > 1 ? `${n} Fantrax players fit "${want.name}", none uniquely` : `no Fantrax player fits "${want.name}" (${want.nhl || "?"})`;
          }
        }
      }
      if (hit && f2Has(f2r, hit.id)) { why = `name points at ${hit.name} (${hit.id}), who is already someone else on F2`; hit = null; }
      delete roster[pid];
      if (hit) {
        roster[hit.id] = want;
        aliases.push({ team: tid, f2: pid, fantrax: hit.id, name: want.name, fxName: hit.name });
      } else {
        unresolved.push({ team: tid, f2: pid, name: want.name, why });
      }
    }
  }
  return { aliases, unresolved, noDropTeams: new Set(unresolved.map((u) => u.team)) };
}

function vancouverNowIso() {
  // F2 stores lock_ts as naive local (Pacific) time; compare in the same frame
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

function pickPeriod(league, useArg = true) {
  const rcps = (league.rcps || []).filter((r) => r.number >= 1);
  if (useArg && PERIOD_ARG != null) {
    const r = rcps.find((x) => x.number === PERIOD_ARG);
    if (!r) throw new Error(`F2 has no period ${PERIOD_ARG}`);
    return r;
  }
  const now = vancouverNowIso();
  const locked = rcps.filter((r) => r.lock_ts ? r.lock_ts <= now : r.start_date <= now.slice(0, 10));
  if (!locked.length) throw new Error("No F2 period has locked yet");
  return locked[locked.length - 1];
}

async function readF2(period) {
  const league = await f2("/api/league");
  const teams = league.teams || [];
  const rosters = {};
  for (const t of teams) {
    const r = await f2(`/api/teams/${t.id}/roster?rcp=${period.number}`);
    rosters[t.id] = {};
    for (const p of r.players || []) rosters[t.id][p.id] = { status: p.status, pos: p.pos, name: p.name, nhl: p.nhl_team || "" };
  }
  return { league, teams, rosters };
}

// Never mirror a broken F2 onto Fantrax: that is the one failure this whole thing exists to survive.
function sanityF2(f2data) {
  const problems = [];
  if (f2data.teams.length !== 6) problems.push(`F2 returned ${f2data.teams.length} teams, expected 6`);
  for (const t of f2data.teams) {
    const n = Object.keys(f2data.rosters[t.id] || {}).length;
    const act = Object.values(f2data.rosters[t.id] || {}).filter((p) => p.status === "ACTIVE").length;
    if (n < 15) problems.push(`${t.name}: only ${n} players on F2`);
    if (act < 10) problems.push(`${t.name}: only ${act} Active on F2`);
  }
  return problems;
}

// ---- Fantrax session -------------------------------------------------------
// The login is Sparky Live's own (src/scrape.js), which has been signing in nightly since March:
// Fantrax's login is an Angular Material dialog, not a plain form.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fantraxLogin(page) {
  log("Fantrax: logging in");
  await page.goto(`${FX}/login`, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await sleep(3000);

  if (!(await page.$("mat-dialog-container, .mat-mdc-dialog-container"))) {
    const opened = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a")).find((x) => x.textContent.trim().toLowerCase() === "login");
      if (b) { b.click(); return true; }
      return false;
    });
    if (opened) await sleep(2000);
  }

  try {
    await page.waitForSelector("mat-dialog-container input, .mat-mdc-dialog-container input, .mat-mdc-form-field input, input[matinput], input.mat-mdc-input-element", { timeout: 15000 });
  } catch (_) {
    await page.screenshot({ path: "debug-f1-login-page.png", fullPage: true }).catch(() => {});
    throw new Error("Fantrax login dialog never appeared (screenshot: debug-f1-login-page.png)");
  }

  const inDialog = await page.$$("mat-dialog-container input, .mat-mdc-dialog-container input");
  let emailInput, passwordInput;
  if (inDialog.length >= 2) [emailInput, passwordInput] = inDialog;
  else {
    emailInput = (await page.$$('input[type="text"], input[type="email"], input:not([type="password"]):not([type="hidden"])'))[0];
    passwordInput = await page.$('input[type="password"]');
  }
  if (!emailInput || !passwordInput) throw new Error("Fantrax login inputs not found");

  await emailInput.click({ clickCount: 3 });
  await emailInput.type(FX_EMAIL, { delay: 30 });
  await sleep(500);
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(FX_PASSWORD, { delay: 30 });
  await sleep(500);

  const clicked = await page.evaluate(() => {
    const act = document.querySelector("mat-dialog-actions, mat-mdc-dialog-actions, .mat-mdc-dialog-actions, .mat-dialog-actions");
    for (const b of act ? act.querySelectorAll("button") : []) if (b.textContent.trim().toLowerCase().includes("login")) { b.click(); return true; }
    for (const b of document.querySelectorAll("button")) if (b.textContent.trim().toLowerCase() === "login" && b.offsetParent !== null) { b.click(); return true; }
    const dlg = document.querySelector("mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane");
    if (dlg) {
      const bs = dlg.querySelectorAll("button");
      for (const b of bs) if (b.textContent.trim().toLowerCase().includes("login") || b.classList.contains("mat-primary")) { b.click(); return true; }
      if (bs.length) { bs[bs.length - 1].click(); return true; }
    }
    return false;
  });
  if (!clicked) await passwordInput.press("Enter");

  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await sleep(5000);
  if (page.url().includes("/login")) {
    await page.screenshot({ path: "debug-f1-login-failed.png", fullPage: true }).catch(() => {});
    throw new Error("Fantrax login failed: still on /login. Wrong credentials or a reCAPTCHA (screenshot: debug-f1-login-failed.png)");
  }
  log("Fantrax: logged in");
}

async function fantraxSession() {
  const browser = await puppeteer.launch({ headless: HEADLESS ? "new" : false, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  // Catch the client's own request envelope (v / uiv) so ours looks identical
  const envelope = { uiv: 3, v: null };
  page.on("request", (req) => {
    if (!req.url().includes("/fxpa/req")) return;
    try { const b = JSON.parse(req.postData() || "{}"); if (b.v) envelope.v = b.v; if (b.uiv) envelope.uiv = b.uiv; } catch (_) {}
  });

  await fantraxLogin(page);

  await page.goto(`${FX}/fantasy/league/${LEAGUE}/team/roster`, { waitUntil: "networkidle2" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  if (!envelope.v) {
    envelope.v = "186.2.7";
    log("Fantrax: WARNING could not read client version, falling back to", envelope.v);
  } else log("Fantrax: client version", envelope.v);

  async function fx(method, data = {}) {
    const body = JSON.stringify({ msgs: [{ method, data }], uiv: envelope.uiv, refUrl: page.url(), dt: 0, at: 0, tz: TZ, v: envelope.v });
    const text = await page.evaluate(async (url, b) => {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: b, credentials: "include" });
      return r.text();
    }, `/fxpa/req?leagueId=${LEAGUE}`, body);
    let o;
    try { o = JSON.parse(text); } catch (_) { throw new Error(`${method}: non-JSON reply ${text.slice(0, 200)}`); }
    if (o.pageError) throw new Error(`${method}: ${JSON.stringify(o.pageError).slice(0, 300)}`);
    const resp = (o.responses || [])[0] || {};
    if (resp.pageError) throw new Error(`${method}: ${JSON.stringify(resp.pageError).slice(0, 300)}`);
    return resp.data !== undefined ? resp.data : resp;
  }

  return { browser, page, fx };
}

// ---- Fantrax reads -----------------------------------------------------------
function dayInTz(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

async function readFxTeam(fx, teamId, fxPeriod) {
  const d = await fx("getTeamRosterInfo", { teamId, period: String(fxPeriod) });
  const out = {};
  for (const t of d.tables || []) {
    for (const row of t.rows || []) {
      const s = row.scorer;
      if (!s || !s.scorerId) continue;
      out[s.scorerId] = {
        status: ID_STATUS[String(row.statusId)] || `?${row.statusId}`,
        pos: ID_POS[String(row.posId)] || null,
        posId: String(row.posId || ""),
        name: s.name,
      };
    }
  }
  return { roster: out, sel: d.displayedSelections || {}, commissioner: !!d.commissioner };
}

// Fantrax's period numbering may or may not include F2's Period 0. Find it by date, don't assume.
async function resolveFxPeriod(fx, teamId, f2Period) {
  for (const off of [0, 1, -1]) {
    const n = f2Period.number + off;
    if (n < 1) continue;
    const { sel, commissioner } = await readFxTeam(fx, teamId, n);
    if (!commissioner) throw new Error("This Fantrax login is not a commissioner of the league");
    const start = sel.displayedStartDate;
    if (!start) continue;
    const days = [dayInTz(start, "America/New_York"), dayInTz(start, TZ)];
    if (days.includes(f2Period.start_date)) return n;
  }
  throw new Error(`No Fantrax period starts on ${f2Period.start_date} (F2 period ${f2Period.number})`);
}

async function readFx(fx, teams, fxPeriod) {
  const rosters = {};
  for (const t of teams) rosters[t.id] = (await readFxTeam(fx, t.id, fxPeriod)).roster;
  return rosters;
}

// ---- diff ----------------------------------------------------------------------
function ownerMap(rosters) {
  const m = {};
  for (const [tid, r] of Object.entries(rosters)) for (const pid of Object.keys(r)) m[pid] = tid;
  return m;
}

function diff(f2r, fxr, teams, noDrop = new Set()) {
  const f2Own = ownerMap(f2r), fxOwn = ownerMap(fxr);
  const trades = {}, drops = {}, claims = {}, lineups = {}, blockedDrops = [];
  for (const [pid, dst] of Object.entries(f2Own)) {
    const src = fxOwn[pid];
    if (!src) (claims[dst] = claims[dst] || []).push(pid);
    else if (src !== dst) {
      const key = [src, dst].sort().join("|");
      (trades[key] = trades[key] || []).push({ pid, src, dst });
    }
  }
  for (const [pid, src] of Object.entries(fxOwn)) {
    if (f2Own[pid]) continue;
    if (noDrop.has(src)) blockedDrops.push({ pid, team: src });
    else (drops[src] = drops[src] || []).push(pid);
  }
  for (const t of teams) {
    const changes = [];
    for (const [pid, want] of Object.entries(f2r[t.id] || {})) {
      const have = (fxr[t.id] || {})[pid];
      if (!have) continue; // arrives via trade/claim; lineup pass re-reads after membership
      if (have.status !== want.status || (want.status === "ACTIVE" && want.pos && have.pos !== want.pos)) changes.push({ pid, from: have.status, to: want.status });
    }
    if (changes.length) lineups[t.id] = changes;
  }
  const membership = Object.values(trades).reduce((a, l) => a + l.length, 0)
    + Object.values(drops).reduce((a, l) => a + l.length, 0) + Object.values(claims).reduce((a, l) => a + l.length, 0);
  const lineupCount = Object.values(lineups).reduce((a, l) => a + l.length, 0);
  return { trades, drops, claims, lineups, blockedDrops, membership, lineupCount, clean: membership === 0 && lineupCount === 0 && blockedDrops.length === 0 };
}

function describe(d, names, teamName) {
  const nm = (pid) => names[pid] || pid;
  const lines = [];
  for (const legs of Object.values(d.trades)) for (const l of legs) lines.push(`TRADE  ${nm(l.pid)}: ${teamName(l.src)} -> ${teamName(l.dst)}`);
  for (const [tid, pids] of Object.entries(d.drops)) for (const p of pids) lines.push(`DROP   ${nm(p)} from ${teamName(tid)}`);
  for (const [tid, pids] of Object.entries(d.claims)) for (const p of pids) lines.push(`CLAIM  ${nm(p)} to ${teamName(tid)}`);
  for (const [tid, ch] of Object.entries(d.lineups)) for (const c of ch) lines.push(`LINEUP ${teamName(tid)}: ${nm(c.pid)} ${c.from} -> ${c.to}`);
  for (const b of d.blockedDrops || []) lines.push(`HELD   ${nm(b.pid)} on ${teamName(b.team)}: not on F2, but that team has an unmatched F2 player, so no drop`);
  return lines;
}

// ---- Fantrax writes --------------------------------------------------------

async function doTrades(fx, d, fxPeriod, results, carryForward = true) {
  for (const legs of Object.values(d.trades)) {
    const transactions = {};
    legs.forEach((l, i) => { transactions[String(i)] = `SC,${l.pid},${l.src},${l.dst},${i}`; });
    try {
      // the Commissioner Trade page's own request (Fantrax client, chunk-NIZJ754D): adminMode + future + override:false + period
      const r = await fx("createTrade", { adminMode: true, future: carryForward, override: false, transactions, msg: "F2 mirror", period: fxPeriod });
      const bad = (r.txResponses || []).find((t) => ["WARNING", "DENIED", "ERROR"].includes(t.code));
      const tx = bad || (r.txResponses || [])[0];
      results.push({ step: "trade", legs, ok: !bad && !!tx, msg: tx && (tx.message || tx.genericMessage || tx.genericMsg) });
    } catch (e) { results.push({ step: "trade", legs, ok: false, msg: e.message }); }
  }
}

async function doClaimsDrops(fx, d, f2r, fxPeriod, results, carryForward = true) {
  const teamIds = new Set([...Object.keys(d.drops), ...Object.keys(d.claims)]);
  const sets = [];
  for (const tid of teamIds) {
    const dr = [...(d.drops[tid] || [])], cl = [...(d.claims[tid] || [])];
    while (dr.length && cl.length) sets.push({ tid, claim: cl.shift(), drop: dr.shift() });
    dr.forEach((p) => sets.push({ tid, drop: p }));
    cl.forEach((p) => sets.push({ tid, claim: p }));
  }
  // drop-only first, then pairs, then claim-only: keeps Fantrax under roster max the whole way
  sets.sort((a, b) => (a.claim ? (a.drop ? 1 : 2) : 0) - (b.claim ? (b.drop ? 1 : 2) : 0));

  // Payloads as the Commissioner Add/Drop dialog sends them (Fantrax client, chunk-4YPLXFRG). The period
  // field is rosterLimitPeriod, NOT period: tested live Oct 6, a bare `period` is ignored and Fantrax
  // defaults the claim to a later period (it said Period 3 for a Period 1 move).
  for (const s of sets) {
    const txs = [];
    if (s.claim) txs.push({ type: "CLAIM", teamId: s.tid, scorerId: s.claim });
    if (s.drop) txs.push({ type: "DROP", teamId: s.tid, scorerId: s.drop });
    try {
      const conf = await fx("getClaimDropCommissionerConfirmInfo", { adminMode: true, transactionSets: [{ transactions: txs }], rosterLimitPeriod: fxPeriod });
      const pre = (conf.txResponses || []).find((t) => ["WARNING", "DENIED", "ERROR"].includes(t.code));
      if (pre) { results.push({ step: "claimdrop", ...s, ok: false, msg: (pre.detailMessages || []).join(" ") || pre.genericMessage || pre.code }); continue; }
      const c = (conf.confirmResponses || [])[0] || {};
      if (s.claim && Number(c.claimPeriod) !== Number(fxPeriod)) {
        // the guard that caught the bug above: never let a claim land in a different period than asked
        results.push({ step: "claimdrop", ...s, ok: false, msg: `Fantrax would make it effective period ${c.claimPeriod}, not ${fxPeriod}: not sent` });
        continue;
      }
      const want = s.claim ? (f2r[s.tid] || {})[s.claim] : null;
      const full = txs.map((t) => {
        if (t.type === "DROP") return { ...t, ...(c.defaultClaimRosterActionId ? { claimRosterActionId: c.defaultClaimRosterActionId } : {}) };
        return {
          ...t,
          positionId: (want && POS_ID[want.pos]) || c.defaultPosId || (c.positions || [])[0]?.id,
          claimToStatusId: STATUS_ID.RESERVE,                               // the lineup pass sets the real status
          ...(c.salariesUsed && c.defaultSalary != null ? { salary: Number(c.defaultSalary) } : {}),
          ...(c.contractsUsed && c.defaultContractSmallId ? { contractSmallId: c.defaultContractSmallId } : {}),
        };
      });
      const r = await fx("createClaimDropCommissioner", {
        adminMode: true, adminModeClaimImmediate: true, rosterLimitPeriod: fxPeriod,
        transactionSets: [{ transactions: full }],
        ...(c.showYesNo ? { applyToFuturePeriods: carryForward } : {}),
      });
      const prompt = (r.txResponses || []).find((t) => t.extraCode === "PROMPT_FOR_OVERRIDE");
      if (prompt) {                                                         // Fantrax says it would make the roster illegal: never forced
        results.push({ step: "claimdrop", ...s, ok: false, msg: `Fantrax: would make the roster illegal (${(prompt.detailMessages || []).join(" ")}). Not forced.` });
        continue;
      }
      const bad = (r.txResponses || []).find((t) => ["WARNING", "DENIED", "ERROR"].includes(t.code));
      const tx = bad || (r.txResponses || [])[0];
      results.push({ step: "claimdrop", ...s, ok: !bad && !!tx, msg: tx && ((tx.detailMessages || []).join(" ") || tx.genericMessage || tx.code), claimPeriod: c.claimPeriod });
    } catch (e) { results.push({ step: "claimdrop", ...s, ok: false, msg: e.message }); }
  }
}

async function doLineups(fx, teams, f2r, fxr, fxPeriod, results, carryForward = true) {
  for (const t of teams) {
    const want = f2r[t.id] || {}, have = fxr[t.id] || {};
    const differs = Object.entries(want).some(([pid, w]) => have[pid] && (have[pid].status !== w.status || (w.status === "ACTIVE" && w.pos && have[pid].pos !== w.pos)));
    if (!differs) continue;
    const fieldMap = {};
    for (const [pid, w] of Object.entries(want)) {
      if (!have[pid]) continue;
      fieldMap[pid] = { posId: POS_ID[w.pos] || have[pid].posId, stId: STATUS_ID[w.status] || STATUS_ID.RESERVE };
    }
    // carryForward only for the newest period: a fix to a past period stays in that period, so it can't
    // overwrite later lineups (the sweep fixes those in their own turn, oldest to newest)
    const base = { rosterLimitPeriod: String(fxPeriod), fantasyTeamId: t.id, daily: false, adminMode: true, applyToFuturePeriods: carryForward, fieldMap };
    try {
      const pre = await fx("confirmOrExecuteTeamRosterChanges", { ...base, confirm: true });
      const fr = pre.fantasyResponse || {};
      if (fr.msgType === "ERROR" && fr.removeSubmitButton) {
        results.push({ step: "lineup", team: t.name, ok: false, msg: strip(fr.mainMsg) });
        continue;
      }
      const r = await fx("confirmOrExecuteTeamRosterChanges", { ...base, confirm: false });
      const er = (r.fantasyResponse || {});
      results.push({ step: "lineup", team: t.name, ok: er.msgType !== "ERROR", msg: strip(er.mainMsg) || `${r.lineupChangesExecuted ?? "?"} changes`, warn: fr.msgType === "WARNING" ? strip(fr.mainMsg) : undefined });
    } catch (e) { results.push({ step: "lineup", team: t.name, ok: false, msg: e.message }); }
  }
}

const strip = (s) => (s || "").replace(/<[^>]+>/g, "").trim();

// ---- standings parity --------------------------------------------------------
function num(s) { if (s == null) return null; const v = parseFloat(String(s).replace(/,/g, "")); return Number.isFinite(v) ? v : null; }

async function standingsParity(fx) {
  const ours = await f2("/api/standings");
  const d = await fx("getStandings", {});
  const fxPts = {};
  for (const tl of d.tableList || []) {
    const heads = ((tl.header || {}).cells || []).map((c) => c.name || c.shortName || "");
    const i = heads.indexOf("Fantasy Points");
    if (i < 0) continue;
    for (const r of tl.rows || []) {
      const team = (r.fixedCells || []).map((c) => c.teamId).find(Boolean);
      if (team && fxPts[team] === undefined) fxPts[team] = num(((r.cells || [])[i] || {}).content);
    }
  }
  // F2 adds a day's games to its season totals after midnight (its first poll of the next day), so at
  // 23:00 F2 holds games through YESTERDAY while Fantrax already counts tonight's. Same-moment numbers
  // never match on a game night. The fair comparison is F2 tonight against Fantrax as recorded by the
  // previous night's run: both are "through yesterday", every one of those games final.
  const prev = previousRun();
  return ours.map((r) => {
    const a = num(r.points), now = fxPts[r.id] ?? null;
    const base = prev ? prev.fx[r.id] : undefined;
    const compared = base !== undefined && base !== null && a != null;
    return { id: r.id, team: r.name, f2: a, fantrax: now, fantraxPrevNight: compared ? base : null,
             compared, same: compared ? Math.abs(a - base) < 0.005 : true };
  });
}

// Fantrax's totals from the previous night's run (18 to 30 hours ago), the "through yesterday" baseline.
function previousRun() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json")).sort().reverse();
    for (const f of files) {
      const r = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), "utf8"));
      const age = now - Date.parse(r.at || 0);
      if (!Array.isArray(r.standings) || age < 18 * 3600e3) continue;
      if (age > 30 * 3600e3) return null;                      // last night's run is missing: no fair baseline
      const fx = {};
      for (const s of r.standings) if (s.id) fx[s.id] = s.fantrax;
      return Object.keys(fx).length ? { at: r.at, fx } : null;
    }
  } catch (_) {}
  return null;
}

// ---- Slack -----------------------------------------------------------------------
async function slack(text) {
  if (!SLACK_TOKEN || !SLACK_CHANNEL) return;
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
  });
  const o = await r.json();
  if (!o.ok) log("Slack error:", o.error);
}

// ---- main: the janitor sweep -----------------------------------------------------------
// Default: every locked period, oldest to newest, so a commissioner fix to an old period on F2
// reaches Fantrax too. --period N does one period; --latest does only the newest locked one.
// Fantrax rescores a period whenever its roster changes, so being late costs nothing.
(async () => {
  const report = { at: new Date().toISOString(), mode: VERIFY_ONLY ? "verify" : APPLY ? "apply" : "dry-run", periods: [] };
  let session;
  try {
    await f2Login();
    const league = await f2("/api/league");
    const newest = pickPeriod(league, false);                                   // the newest period that has locked
    const locked = (league.rcps || []).filter((r) => r.number >= 1 && r.number <= newest.number).sort((a, b) => a.number - b.number);
    const sweep = PERIOD_ARG != null ? [pickPeriod(league)] : LATEST_ONLY ? [newest] : locked;
    report.swept = sweep.map((p) => p.number);
    report.lockTs = locked[locked.length - 1].lock_ts;
    log(`F2: sweeping period${sweep.length > 1 ? "s" : ""} ${sweep.map((p) => p.number).join(", ")}`);

    session = await fantraxSession();
    const { fx } = session;
    let totalMembership = 0;
    let teamName = (id) => id;

    for (const period of sweep) {
      const isNewest = period.number === newest.number;
      const pr = { f2Period: period.number };
      report.periods.push(pr);
      log(`--- Period ${period.number} (${period.start_date} - ${period.end_date})`);

      const f2data = await readF2(period);
      teamName = (id) => (f2data.teams.find((t) => t.id === id) || {}).name || id;
      const problems = sanityF2(f2data);
      if (problems.length) throw new Error(`F2 failed sanity checks for Period ${period.number}, refusing to mirror:\n  ` + problems.join("\n  "));

      const fxPeriod = await resolveFxPeriod(fx, f2data.teams[0].id, period);
      pr.fxPeriod = fxPeriod;

      const names = {};
      for (const r of Object.values(f2data.rosters)) for (const [pid, p] of Object.entries(r)) names[pid] = p.name;
      let fxr = await readFx(fx, f2data.teams, fxPeriod);
      for (const r of Object.values(fxr)) for (const [pid, p] of Object.entries(r)) names[pid] = names[pid] || p.name;

      const ids = await resolveIds(fx, f2data.rosters, fxr);
      pr.aliases = ids.aliases;
      pr.unresolved = ids.unresolved;
      for (const u of ids.unresolved) log(`ID: UNRESOLVED ${u.name} (F2 ${u.f2}) on ${teamName(u.team)}: ${u.why}. Skipped, drops on that team held`);
      const noDrop = ids.noDropTeams;

      const before = diff(f2data.rosters, fxr, f2data.teams, noDrop);
      pr.plan = describe(before, names, teamName);
      log(before.clean ? "In sync." : `Plan (${before.membership} membership, ${before.lineupCount} lineup):\n  ` + pr.plan.join("\n  "));
      if (!APPLY || VERIFY_ONLY || before.clean) { pr.remaining = APPLY ? [] : pr.plan; continue; }

      totalMembership += before.membership;
      if (totalMembership > MAX_CHANGES && !FORCE)
        throw new Error(`${totalMembership} membership changes (through Period ${period.number}) exceeds MAX_MEMBERSHIP_CHANGES=${MAX_CHANGES}. Check F2, then rerun with --force.`);

      const results = [];
      if (Object.keys(before.trades).length) { log("Trades..."); await doTrades(fx, before, fxPeriod, results, true); }
      if (Object.keys(before.drops).length || Object.keys(before.claims).length) { log("Claims/drops..."); await doClaimsDrops(fx, before, f2data.rosters, fxPeriod, results, true); }
      fxr = await readFx(fx, f2data.teams, fxPeriod);
      log("Lineups...");
      await doLineups(fx, f2data.teams, f2data.rosters, fxr, fxPeriod, results, isNewest);
      pr.results = results;

      fxr = await readFx(fx, f2data.teams, fxPeriod);
      const after = diff(f2data.rosters, fxr, f2data.teams, noDrop);
      pr.remaining = describe(after, names, teamName);
    }

    if (!SKIP_POINTS) report.standings = await standingsParity(fx);
    const dirty = report.periods.some((p) => (p.remaining || []).length);
    await post(report, teamName);
    finish(report, APPLY && dirty ? 1 : 0);
  } catch (e) {
    report.error = e.message;
    log("FAILED:", e.message);
    await slack(`:rotating_light: *Fantrax janitor failed* (${report.mode})\n\`\`\`${e.message.slice(0, 1500)}\`\`\``);
    finish(report, 1);
  } finally {
    if (session) await session.browser.close().catch(() => {});
  }

  async function post(report, teamName) {
    const P = report.periods;
    const span = P.length > 1 ? `Periods ${P[0].f2Period}-${P[P.length - 1].f2Period}` : `Period ${P[0] ? P[0].f2Period : "?"}`;
    const applied = P.flatMap((p) => (p.results || []).map((r) => ({ ...r, period: p.f2Period })));
    const fails = applied.filter((r) => !r.ok);
    const left = P.filter((p) => (p.remaining || []).length);
    const unresolved = P.flatMap((p) => (p.unresolved || []).map((u) => ({ ...u, period: p.f2Period })));
    const aliases = [...new Map(P.flatMap((p) => p.aliases || []).map((a) => [a.f2, a])).values()];

    const lines = [];
    if (!APPLY && !VERIFY_ONLY) lines.push(`*Fantrax janitor (dry run): ${span}*`);
    else if (!left.length) lines.push(`:white_check_mark: *Fantrax janitor: ${span}*: all 6 rosters match F2 in every period.`);
    else lines.push(`:warning: *Fantrax janitor: ${span}*: ${left.map((p) => `Period ${p.f2Period} (${p.remaining.length})`).join(", ")} still differ.`);
    if (applied.length) lines.push(`Fixed tonight: ${applied.length - fails.length}/${applied.length} changes across ${new Set(applied.map((r) => r.period)).size} period(s).`);
    for (const f of fails) lines.push(`• Period ${f.period}: failed ${f.step} ${f.team || teamName(f.tid) || ""}: ${f.msg || "no message"}`);
    for (const u of unresolved) lines.push(`• :warning: Period ${u.period}: couldn't place ${u.name} (${teamName(u.team)}): ${u.why}. Fix by hand on Fantrax; drops on that team were held`);
    for (const a of aliases) lines.push(`• matched by name: ${a.name} (F2 ${a.f2}) = ${a.fxName} (Fantrax ${a.fantrax})`);
    for (const p of left) lines.push(`Period ${p.f2Period}:\n\`\`\`` + p.remaining.slice(0, 20).join("\n") + (p.remaining.length > 20 ? `\n... ${p.remaining.length - 20} more` : "") + "```");
    // Points, through yesterday on both sites (see standingsParity): F2 now vs Fantrax as of last night's run.
    const st = report.standings || [];
    const compared = st.filter((s) => s.compared);
    const bad = compared.filter((s) => !s.same);
    if (report.standings) {
      if (!compared.length) lines.push("Season points: no run from last night to compare against yet; tonight's Fantrax totals are saved as tomorrow's baseline.");
      else if (bad.length) lines.push(`:warning: Season points through yesterday differ for ${bad.length} team(s)${applied.length ? " (rosters were fixed tonight; if those changes touched yesterday or earlier, tomorrow's run re-checks)" : ""}:\n` + bad.map((s) => `• ${s.team}: F2 ${s.f2}, Fantrax ${s.fantraxPrevNight}`).join("\n"));
      else lines.push(":white_check_mark: Season points through yesterday match on both sites.");
    }
    log("\n" + lines.join("\n"));

    // QUIET (scheduled): post only when there's something to say: the run on the day a period locks
    // (the receipt), anything fixed or failed or left over, an unplaced player, or points that differ.
    const freshLock = report.lockTs && (Date.parse(vancouverNowIso()) - Date.parse(report.lockTs)) < 24 * 3600 * 1000;
    const noteworthy = freshLock || bad.length || applied.length || left.length || unresolved.length;
    if (QUIET && !noteworthy) { log("Quiet run: everything matches, nothing to post."); return; }
    await slack(lines.join("\n"));
  }
})();

function finish(report, code = 0) {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const tag = report.swept && report.swept.length > 1 ? `p${report.swept[0]}-${report.swept[report.swept.length - 1]}` : `p${(report.swept || ["x"])[0]}`;
    const f = path.join(REPORT_DIR, `${report.at.slice(0, 10)}-${tag}-${report.mode}.json`);
    fs.writeFileSync(f, JSON.stringify(report, null, 2));
    log("Report:", f);
  } catch (e) { log("Could not write report:", e.message); }
  process.exitCode = code;
}
