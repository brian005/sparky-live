// ============================================================
// Daily Faceoff lines, read once for the whole league (Sparky Lens)
// ============================================================
// Every Sparky Lens used to read all 32 of Daily Faceoff's line-combination pages itself, every 3 hours. This reads
// them once, here on GitHub Actions (lines.yml, every 2 hours), and publishes data/lines/latest.json; each Lens reads
// that one file instead, and only goes to Daily Faceoff itself when the file is missing or more than 8 hours old.
//
// The rows are exactly the ones Lens builds from a team page (summarizeTeam below is Lens's own, background.js):
//   { name, team, pos: "F"|"D"|"", ev: "1C"|"2LW"|"1RD"|"", evMates: [names], pp: [{unit: "PP1", mates}], pk: [...] }
// Only each skater's slots: no goalies, no injured list, nothing else from the page.
//
// File: { v: 1, src: "dailyfaceoff", at: ms of this read, failed: [team abbrs that didn't load this time], rows }
// A team whose page fails keeps its rows from the last file (it's listed in failed, so Lens's movers skip it).
// The file is rewritten only when a row changed, or when the last read is 5+ hours old (so its "at" never goes
// stale to Lens while the lines sit still); otherwise it's left alone and there's nothing to commit.
//
// Flags: --force (write even if nothing changed), --out <path>. Env: DFO_BASE (a stand-in site, for testing).
// Node 20, built-ins only.
// ============================================================

const fs = require("fs");
const path = require("path");

const DFO = process.env.DFO_BASE || "https://www.dailyfaceoff.com";
const UA = "sparky-live-lines/1.0 (+https://github.com/brian005/sparky-live)";
const PACE_MS = Number(process.env.DFO_PACE_MS || 1500);   // between pages: one reader, going slowly
const REWRITE_AFTER = 5 * 3600e3;
const MAX_FAILED = 8;                                       // more teams than this failing: don't publish this read
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(__dirname, "..", "data", "lines", "latest.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one page's Next.js data; a 429 / 5xx waits and tries again (Retry-After when given)
async function dfoPage(slug) {
  const url = `${DFO}/teams/${slug}/line-combinations`;
  const waits = [5, 15, 30];
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: { Accept: "text/html", "User-Agent": UA } });
    if ((r.status === 429 || r.status >= 500) && i < waits.length) {
      const ra = Number(r.headers.get("retry-after"));
      await sleep((Number.isFinite(ra) && ra > 0 ? ra : waits[i]) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("no page data (a challenge page?)");
    return JSON.parse(m[1]).props.pageProps;
  }
}

// Lens's own (background.js summarizeTeam), unchanged: one record per skater on a team page: EV slot ("1C", "2LW",
// "1RD"), PP / PK units, and the names of the others in each unit for the hover. Goalies and the IR group are left out.
function summarizeTeam(abbr, combo) {
  const players = combo.players || [];
  const groups = {};                                   // groupIdentifier -> [{name, pos}]
  for (const p of players) (groups[p.groupIdentifier] = groups[p.groupIdentifier] || []).push({ key: p.playerId ?? p.id ?? p.name, name: p.name });
  const out = {};
  // keyed by DFO's player id when present: VAN carries two Elias Petterssons (C and D)
  const key = (p) => p.playerId ?? p.id ?? p.name;
  const get = (p) => out[key(p)] || (out[key(p)] = { name: p.name, team: abbr, pos: "", ev: "", evMates: [], pp: [], pk: [] });
  for (const p of players) {
    const g = String(p.groupIdentifier || "").toLowerCase();
    const pos = String(p.positionIdentifier || "").toUpperCase();
    const mates = (groups[p.groupIdentifier] || []).filter((x) => x.key !== key(p)).map((x) => x.name);
    let m;
    if ((m = g.match(/^f(\d)$/))) { const s = get(p); s.pos = "F"; s.ev = `${m[1]}${pos}`; s.evMates = mates; }
    else if ((m = g.match(/^d(\d)$/))) { const s = get(p); s.pos = "D"; s.ev = `${m[1]}${pos}`; s.evMates = mates; }
    else if ((m = g.match(/^pp(\d)$/))) get(p).pp.push({ unit: `PP${m[1]}`, mates });
    else if ((m = g.match(/^pk(\d)$/))) get(p).pk.push({ unit: `PK${m[1]}`, mates });
    // "g" (goalies) and "ir" deliberately ignored
  }
  // a PP/PK-only listing with no EV slot still needs a position group for matching
  for (const s of Object.values(out)) if (!s.pos) s.pos = /^(LD|RD|D)$/.test((players.find((p) => p.name === s.name && /^(f|d)\d$/.test(p.groupIdentifier)) || {}).positionIdentifier || "") ? "D" : "";
  return Object.values(out).filter((s) => s.ev || s.pp.length || s.pk.length);
}

const order = (a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : (a.ev < b.ev ? -1 : a.ev > b.ev ? 1 : 0));

async function main() {
  const prior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  const first = await dfoPage("vancouver-canucks").catch((e) => { throw new Error(`Daily Faceoff's first page didn't load: ${e.message}`); });
  const teams = (first.sortedTeams || []).map((t) => ({ abbr: t.shortName, slug: t.slug })).filter((t) => t.abbr && t.slug);
  if (teams.length < 30) throw new Error(`Daily Faceoff listed ${teams.length} teams (expected 32)`);
  const rows = [], failed = [];
  for (const t of teams) {
    try {
      const pp = t.slug === "vancouver-canucks" ? first : (await sleep(PACE_MS), await dfoPage(t.slug));
      const got = summarizeTeam(t.abbr, pp.combinations || {});
      if (!got.length) throw new Error("no lines on the page");
      rows.push(...got);
    } catch (e) {
      failed.push(t.abbr);
      console.log(`  ${t.abbr}: ${e.message}`);
      if (prior && Array.isArray(prior.rows)) rows.push(...prior.rows.filter((r) => r.team === t.abbr));   // last read's, kept
      if (failed.length > MAX_FAILED) throw new Error(`${failed.length} team pages failed (${failed.join(", ")}): stopped, not publishing`);
    }
  }
  rows.sort(order);
  const same = prior && JSON.stringify(prior.rows) === JSON.stringify(rows) && JSON.stringify(prior.failed || []) === JSON.stringify(failed);
  const fresh = prior && Date.now() - prior.at < REWRITE_AFTER;
  console.log(`Daily Faceoff: ${rows.length} skaters on ${teams.length - failed.length} of ${teams.length} teams` + (failed.length ? ` (failed: ${failed.join(", ")})` : ""));
  if (same && fresh && !FORCE) { console.log("Nothing changed since the last read: file left alone"); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ v: 1, src: "dailyfaceoff", at: Date.now(), failed, rows }) + "\n");
  console.log(same ? "No line changes; rewrote it so the read time stays fresh" : `Wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
