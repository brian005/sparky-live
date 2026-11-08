// ============================================================
// NIGHT RECORDS: every finished night, each franchise and the whole pool against every night since 2013-14
// ============================================================
// Used by src/records.js. Four levels for every franchise stat, strongest first, one line per franchise per
// stat at the strongest level it reaches:
//   pool-any   the pool record for any night
//   pool-n     the pool record for a night in Period N (Period 5 nights, every season)
//   fr-any     the franchise's own record for any night
//   fr-n       the franchise's own record for a night in Period N
// Pool stats (the whole pool's night added up) have the two pool levels. A level needs at least one earlier
// night to beat; a value has to be above zero to count; records and ties are both reported. On a night two
// franchises both pass a pool mark, the pool record only goes to the better one (both, if they're even).
//
// Franchise stats, per night: points, ppg (with NIGHT_PPG_MIN_GP or more playing), points from one NHL game,
// goals, primary points (goals + first assists), power-play points, empty-net points, prospect points,
// different prospects scoring (as before: pool and own records for any night, new records only, no ties),
// and DOMINATION (outscoring every other franchise combined; every one is
// noted, and the margin over everyone else has records of its own). No DOMINATION on a night two or more franchises
// had nobody playing (Brian, 2026-11-06: otherwise "give it a go", whatever the score), in history as tonight.
// A franchise's own tie is announced only when it ties at most OWN_TIE_MAX other nights; past that the next level
// down is tried (a tie of its any-night best can still be a Period N record), and a pool tie always counts.
// Pool stats: points, and ppg (with POOL_PPG_MIN_GP or more playing).
//
// Data:
//   history   data/daily-YYYY-YY/*.json and data/daily/*.json (points, GP; via records.js loadHistory),
//             data/active-stints.json (each season's period dates), data/player-nights/YYYY-YY.json (goals,
//             primary, PP, EN, per-game points; src/player-nights-backfill.js), data/prospect-nights.json
//   this season   data/nightly-report/*.json (teams[id]: scored, gp, g, a1, pp, en, games; players)
// The per-player stats (goals, primary, PP, EN, one NHL game) only run once data/player-nights has every
// season: a record against part of the history would be a false one.
//
// Env:
//   NIGHT_PPG_MIN_GP     default 5    franchise ppg counts with this many or more playing
//   POOL_PPG_MIN_GP      default 20   pool ppg counts with this many or more playing
//   OWN_TIE_MAX          default 2    a franchise's own tie of a mark held by more nights than this isn't announced
// ============================================================

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "data");
const MIN_GP = Number(process.env.NIGHT_PPG_MIN_GP || 5);
const POOL_MIN_GP = Number(process.env.POOL_PPG_MIN_GP || 20);
const OWN_TIE_MAX = Number(process.env.OWN_TIE_MAX || 2);              // Brian, 2026-11-06: skip own ties of 3+ other nights
const EPS = 1e-9;
const two = (x) => x.toFixed(2);
const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;                 // 1 power-play point, 8 power-play points

const FR_STATS = [
  { key: "pts", big: (e) => pl(e.pts, "point"), sub: (e) => `from ${e.gp} games played`, label: "most points", val: (e) => e.pts, show: (e) => `${e.pts} points (${e.gp} GP)` },
  { key: "ppg", big: (e) => `${two(e.pts / e.gp)} PPG`, sub: (e) => `${e.pts} points from ${e.gp} games played`, label: "best PPG", val: (e) => (e.gp >= MIN_GP ? e.pts / e.gp : null), num: two, show: (e) => `${two(e.pts / e.gp)} ppg (${e.pts} in ${e.gp} GP)` },
  { key: "game", big: (e) => pl(e.game.pts, "point"), sub: (e) => `all from ${e.game.id.replace("@", " @ ")}`, detail: true, label: "most points from one NHL game", val: (e) => (e.game ? e.game.pts : null), show: (e) => `${e.game.pts} (${e.game.id})`, ref: (o) => ` (${o.game.id})` },
  { key: "g", big: (e) => pl(e.g, "goal"), detail: true, label: "most goals", val: (e) => e.g, show: (e) => `${e.g}` },
  { key: "prim", big: (e) => pl(e.prim, "primary point"), sub: () => "goals + first assists", detail: true, label: "most primary points", val: (e) => e.prim, show: (e) => `${e.prim}` },
  { key: "pp", big: (e) => pl(e.pp, "power-play point"), detail: true, label: "most power-play points", val: (e) => e.pp, show: (e) => `${e.pp}` },
  { key: "en", big: (e) => pl(e.en, "empty-net point"), detail: true, label: "most empty-net points", val: (e) => e.en, show: (e) => `${e.en}` },
  { key: "pros", big: (e) => pl(e.pros, "prospect point"), sub: (e) => (e.prosWho || []).join(" · "), label: "most prospect points", val: (e) => e.pros, show: (e) => `${e.pros}${e.prosWho && e.prosWho.length ? ` (${e.prosWho.join(", ")})` : ""}` },
  { key: "prosN", big: (e) => `${pl(e.prosN, "prospect")} scoring`, sub: (e) => (e.prosWho || []).join(" · "), levels: ["pool-any", "fr-any"], noTies: true, label: "most different prospects scoring", val: (e) => e.prosN, show: (e) => `${e.prosN}${e.prosWho && e.prosWho.length ? ` (${e.prosWho.join(", ")})` : ""}` },
  { key: "dom", big: (e) => `+${e.margin} points`, sub: (e) => `${e.pts} points to ${e.others} for everyone else combined`, label: "biggest margin of victory", val: (e) => e.margin, num: (v) => `+${v}`, show: (e) => `+${e.margin} points (${e.pts} to ${e.others} for everyone else combined)`, ref: (o) => ` (${o.pts} to ${o.others})` },
];
const POOL_STATS = [
  { key: "lg-pts", big: (e) => pl(e.pts, "point"), sub: (e) => `${e.n} franchises, ${e.gp} games played`, label: "most points", val: (e) => e.pts, show: (e) => `${e.pts} points (${e.gp} GP)` },
  { key: "lg-ppg", big: (e) => `${two(e.pts / e.gp)} PPG`, sub: (e) => `${e.pts} points from ${e.gp} games played`, label: "best PPG", val: (e) => (e.gp >= POOL_MIN_GP ? e.pts / e.gp : null), num: two, show: (e) => `${two(e.pts / e.gp)} ppg (${e.pts} in ${e.gp} GP)` },
];
const STATS = [...FR_STATS, ...POOL_STATS];

// ---- shared ------------------------------------------------------------------------------------------
function seasonOf(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

// every season's period dates (data/active-stints.json): (season, date) -> period number
function periodFinder() {
  const st = readJson(path.join(DATA, "active-stints.json"));
  const rcps = {};
  for (const [s, v] of Object.entries((st && st.seasons) || {})) rcps[s] = v.rcps || [];
  return (season, ymd) => ((rcps[season] || []).find((r) => r.start <= ymd && ymd <= r.end) || {}).n || null;
}

// a night's franchise entries gain the pool-wide numbers: DOMINATION margin, and the pool's own entry. No DOMINATION
// (and no margin) on a night two or more franchises had nobody playing; an unknown GP doesn't count as nobody.
function finishNight(list) {
  const total = list.reduce((s, e) => s + e.pts, 0), gp = list.reduce((s, e) => s + (e.gp || 0), 0);
  const idle = list.filter((e) => e.gp === 0).length;
  for (const e of list) {
    e.others = total - e.pts;
    e.margin = list.length > 1 && idle < 2 && e.pts > e.others ? e.pts - e.others : null;
  }
  const f = list[0];
  return { season: f.season, date: f.date, period: f.period, code: "ALL", pts: total, gp, n: list.length, pool: true };
}

// ---- history -----------------------------------------------------------------------------------------
// nights: [{ season, date, code, pts, gp }] from records.js loadHistory (daily files, every season before this)
function history(nights) {
  const periodOf = periodFinder();
  const detail = {};                                           // "date|code" -> { g, prim, pp, en, game }
  const pnDir = path.join(DATA, "player-nights");
  const built = new Set();
  for (const f of fs.existsSync(pnDir) ? fs.readdirSync(pnDir).filter((x) => /^\d{4}-\d{2}\.json$/.test(x)) : []) {
    const j = readJson(path.join(pnDir, f));
    built.add(j.season);
    for (const [date, n] of Object.entries(j.nights || {})) {
      for (const [code, t] of Object.entries(n.t || {})) {
        const best = Object.entries(t.games || {}).sort((a, b) => b[1] - a[1])[0];
        detail[`${date}|${code}`] = { g: t.g, prim: t.g + t.a1, pp: t.pp, en: t.en, game: best ? { id: best[0], pts: best[1] } : null };
      }
    }
  }
  const pros = readJson(path.join(DATA, "prospect-nights.json"));
  const pnights = {};
  for (const n of (pros && pros.nights) || []) pnights[`${n.date}|${n.code}`] = n;

  const byDate = {};
  for (const n of nights) (byDate[n.date] = byDate[n.date] || []).push(n);
  const out = [];
  for (const date of Object.keys(byDate).sort()) {
    const list = byDate[date].map((n) => {
      const d = detail[`${date}|${n.code}`];
      const has = built.has(n.season);
      const p = pnights[`${date}|${n.code}`];
      return {
        season: n.season, date, period: periodOf(n.season, date), code: n.code, pts: n.pts, gp: n.gp,
        g: d ? d.g : has ? 0 : null, prim: d ? d.prim : has ? 0 : null, pp: d ? d.pp : has ? 0 : null, en: d ? d.en : has ? 0 : null,
        game: d ? d.game : null,
        pros: pros ? (p ? p.pts : 0) : null, prosN: pros ? (p ? p.scorers.length : 0) : null,
      };
    });
    out.push(...list, finishNight(list));
  }
  const seasons = [...new Set(nights.map((n) => n.season))];
  const detailComplete = seasons.length > 0 && seasons.every((s) => built.has(s));
  return { entries: out, built: [...built].sort(), missing: seasons.filter((s) => !built.has(s)).sort(), detailComplete, prospects: !!pros };
}

// ---- this season ---------------------------------------------------------------------------------------
// the nightly report files, full nights only (every game final) of a numbered period, up to today
function current(season, teamCode, today, prospectSet, names) {
  const dir = path.join(DATA, "nightly-report");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const r = readJson(path.join(dir, f));
    if (!r.date || r.date > today || seasonOf(r.date) !== season) continue;
    if (!(r.period >= 1) || !r.games || (r.notFinal || []).length) continue;
    const pros = {};                                              // code -> { pts, who[] }
    if (prospectSet) {
      for (const [pid, p] of Object.entries(r.players || {})) {
        const code = teamCode[p.team];
        if (!code || !prospectSet.has(pid) || !p.pts) continue;
        pros[code] = pros[code] || { pts: 0, who: [] };
        pros[code].pts += p.pts;
        pros[code].who.push(`${p.name || names[pid] || pid} ${p.pts}`);
      }
    }
    const list = [];
    for (const [tid, t] of Object.entries(r.teams || {})) {
      const code = teamCode[tid];
      if (!code) continue;
      const best = t.games ? Object.entries(t.games).sort((a, b) => b[1] - a[1])[0] : null;
      list.push({
        season, date: r.date, period: r.period, code, pts: t.scored || 0, gp: t.gp != null ? t.gp : 0,
        g: t.g || 0, prim: (t.g || 0) + (t.a1 || 0), pp: t.pp || 0, en: t.en || 0,
        game: t.games ? (best ? { id: best[0], pts: best[1] } : null) : null,
        pros: prospectSet ? (pros[code] || {}).pts || 0 : null, prosN: prospectSet ? ((pros[code] || {}).who || []).length : null,
        prosWho: prospectSet ? (pros[code] || {}).who || [] : null,
      });
    }
    if (list.length) out.push(...list, finishNight(list));
  }
  return out;
}

// ---- marks -----------------------------------------------------------------------------------------------
// the best value at every level so far, with who holds it (first to reach it, then anyone who tied it)
function levelsOf(e) {
  if (e.pool) return [["pool-any", "L"], ["pool-n", e.period ? `L|${e.period}` : null]].filter((x) => x[1]);
  return [
    ["pool-any", "P"],
    ["pool-n", e.period ? `P|${e.period}` : null],
    ["fr-any", `F|${e.code}`],
    ["fr-n", e.period ? `F|${e.code}|${e.period}` : null],
  ].filter((x) => x[1]);
}
let DETAIL_ON = true;                                           // set by run(): off until player-nights is complete
function statsOf(e) { return e.pool ? POOL_STATS : DETAIL_ON ? FR_STATS : FR_STATS.filter((s) => !s.detail); }
const valOf = (stat, e) => { const v = stat.val(e); return v == null || !(v > EPS) ? null : v; };

class Marks {
  constructor() { this.m = new Map(); }
  get(stat, k) { return this.m.get(`${stat.key}|${k}`) || null; }
  add(e) {
    for (const stat of statsOf(e)) {
      const v = valOf(stat, e);
      if (v == null) continue;
      for (const [, k] of levelsOf(e)) {
        const key = `${stat.key}|${k}`, x = this.m.get(key);
        if (!x || v > x.v + EPS) this.m.set(key, { v, holders: [e] });
        else if (Math.abs(v - x.v) <= EPS) x.holders.push(e);
      }
    }
  }
}

// ---- checking a night ------------------------------------------------------------------------------------
function checkNight(list, marks) {
  const recs = [];
  for (const e of list) {
    for (const stat of statsOf(e)) {
      const v = valOf(stat, e);
      if (v == null) continue;
      // a pool mark goes only to the night's best (all of them, if they're even)
      const beaten = list.some((x) => x !== e && !!x.pool === !!e.pool && (valOf(stat, x) || 0) > v + EPS);
      for (const [lv, k] of levelsOf(e)) {
        if (beaten && lv.startsWith("pool")) continue;
        if (stat.levels && !stat.levels.includes(lv)) continue;
        const mark = marks.get(stat, k);
        if (!mark) continue;
        const old = { v: mark.v, holders: mark.holders.slice() };          // as it stood before tonight
        if (v > mark.v + EPS) { recs.push({ e, stat, level: lv, tie: false, old }); break; }
        if (Math.abs(v - mark.v) <= EPS) {
          if (lv.startsWith("fr") && mark.holders.length > OWN_TIE_MAX) continue;   // a well-worn own mark: the next level
          if (!stat.noTies) recs.push({ e, stat, level: lv, tie: true, old });
          break;
        }
      }
    }
  }
  for (const e of list) marks.add(e);
  return recs;
}

// ---- wording -----------------------------------------------------------------------------------------------
// An old mark (or a night it's tied with) names the franchise only on a pool record, where it could be anyone's; a
// franchise's own record is obviously its own nights. A tie says how many other nights it ties, and when, only if
// it's one ("Ties 1 other night: Nov 11, 2023"; "Ties 4 other nights") (Brian, 2026-11-04).
const namesHolder = (r, o) => r.level.startsWith("pool") && !o.pool;
const otherNights = (n) => `${n} other night${n === 1 ? "" : "s"}`;
function wording(fname, prettyDate) {
  const where = (r) => {
    const n = r.e.period;
    if (r.e.pool) return r.level === "pool-n" ? `the record for ${r.stat.label} in a Period ${n} night` : `the record for ${r.stat.label} in a night`;
    return {
      "pool-any": `the pool record for ${r.stat.label} in a night`,
      "pool-n": `the pool record for ${r.stat.label} in a Period ${n} night`,
      "fr-any": `their own record for ${r.stat.label} in a night`,
      "fr-n": `their own record for ${r.stat.label} in a Period ${n} night`,
    }[r.level];
  };
  const num = (stat, v) => (stat.num ? stat.num(v) : String(v));
  const when = (r, o) => `${namesHolder(r, o) ? `${fname(o.code)}, ` : ""}${prettyDate(o.date)}`;
  const ref = (r, o) => `${num(r.stat, r.old.v)}${r.stat.ref ? r.stat.ref(o) : ""}, ${when(r, o)}`;
  const line = (r) => {
    const h = r.old.holders;
    let old;
    if (!r.tie) old = ` Old mark: ${ref(r, h[0])}${h.length > 1 ? `, tied ${h.length - 1} time${h.length === 2 ? "" : "s"} since` : ""}.`;
    else old = h.length === 1 ? ` Ties 1 other night: ${when(r, h[0])}.` : ` Ties ${otherNights(h.length)}.`;
    const who = r.e.pool ? "The Sparky League" : fname(r.e.code);
    return `*${who}* ${r.tie ? "tied" : "set"} ${where(r)}: ${r.stat.show(r.e)}.${old}`;
  };
  const dom = (e) => `*${fname(e.code)}* DOMINATION: ${e.pts} points, more than everyone else combined (${e.others}).`;
  return { line, dom };
}

// ---- cards (Mattermost / Slack message attachments) ---------------------------------------------------------
// Each card also carries `pic`: the same record laid out for a picture (src/record-pics.js), which is how Screech
// posts in Sparky chat since 2026-11-06; the text card is the fallback.
// One card a record: the level's colour down the side, the franchise and its logo, the kind of record, what it is,
// the number in bold, and the old mark (or the nights it ties) underneath. Text is Slack-style (*bold*);
// src/chat.js converts it. Drawn for F2's own chat panel (app/chatapp.js), which is where the league reads
// Sparky chat: its cards take bold, italic and line breaks but no headings (a "### 8" shows the #s), so the
// number is bold, not big. The franchise is the card's top line, so it isn't repeated under the title; a pool
// record says "all-time" there instead.
// The four kinds (Brian's names, 2026-11-02), each a name and a line under it:
//   SPARKY RECORD           all-time                  any franchise, any night               gold
//   P5 RECORD               all-time                  any franchise, a Period 5 night         orange
//   FRANCHISE RECORD        Brian's Endless Winter    that franchise's own, any night        green
//   P5 FRANCHISE RECORD     Brian's Endless Winter    that franchise's own, a Period 5 night  blue
// The whole league added up is "Sparky record" on the top line (the Sparky logo where a franchise's would be), named
// SPARKY RECORD / P5 RECORD, all-time, purple (Brian, 2026-11-08: SPARKY and ALL-TIME, never "pool" or "whole-pool").
// The franchise's line is the card's top line (its name and logo), so only "all-time" is written out.
// The picture's watermark (pic.wm, a big faded logo in its bottom-right corner): the franchise's own logo on its own
// records (and a DOMINATION), the Sparky logo on every all-time one, a franchise's or the whole league's.
const LEVEL = {
  "pool-any": { color: "#F5B301", icon: "🏆", name: () => "SPARKY RECORD" },
  "pool-n": { color: "#FF7A45", icon: "🏆", name: (e) => `P${e.period} RECORD` },
  "fr-any": { color: "#3DDC84", icon: "⭐", name: () => "FRANCHISE RECORD" },
  "fr-n": { color: "#6FB7FF", icon: "⭐", name: (e) => `P${e.period} FRANCHISE RECORD` },
};
const levelName = (r) => (r.e.pool ? (r.level === "pool-n" ? `P${r.e.period} RECORD` : "SPARKY RECORD") : LEVEL[r.level].name(r.e));
const allTime = (r) => r.e.pool || r.level.startsWith("pool");
const POOL_COLOR = "#A78BFA", DOM_COLOR = "#E5484D";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const split = (big) => { const m = String(big).match(/^(\S+)\s+(.*)$/); return m ? [m[1], m[2]] : [String(big), ""]; };   // "8 power-play points" -> 8, power-play points
function cards(fname, prettyDate, logo) {
  const short = (d) => prettyDate(d).replace(/, \d{4}$/, (y) => (y.slice(2) === String(new Date().getFullYear()) ? "" : y));
  const num = (stat, v) => (stat.num ? stat.num(v) : String(v));
  const when = (r, o) => `${namesHolder(r, o) ? `${fname(o.code)} · ` : ""}${short(o.date)}`;
  const ref = (r, o) => `${num(r.stat, r.old.v)}${r.stat.ref ? r.stat.ref(o) : ""} · ${when(r, o)}`;
  const record = (r, fallback) => {
    const lv = LEVEL[r.level], n = r.e.period, h = r.old.holders;
    const what = `${cap(r.stat.label)} in a${r.level.endsWith("-n") ? ` Period ${n}` : ""} night`;
    let oldTitle, oldVal;
    if (!r.tie) { oldTitle = "Old mark"; oldVal = `${ref(r, h[0])}${h.length > 1 ? ` (tied ${h.length - 1}× since)` : ""}`; }
    else { oldTitle = `Ties ${otherNights(h.length)}`; oldVal = h.length === 1 ? when(r, h[0]) : ""; }   // the date only for one
    // the picture names an old mark's franchise by its initialism ("7 · MPP · Nov 1, 2018"): the full name won't fit
    const picWhen = (o) => `${namesHolder(r, o) ? `${o.code} · ` : ""}${short(o.date)}`;
    const picOld = !r.tie ? `${num(r.stat, r.old.v)}${r.stat.ref ? r.stat.ref(h[0]) : ""} · ${picWhen(h[0])}${h.length > 1 ? ` (tied ${h.length - 1}× since)` : ""}`
      : h.length === 1 ? picWhen(h[0]) : "";
    const sub = r.stat.sub ? r.stat.sub(r.e) : "";
    const who = r.e.pool ? "Sparky record" : fname(r.e.code), icon = r.e.pool ? "" : logo(r.e.code);
    const color = r.e.pool ? POOL_COLOR : lv.color, [num0, unit] = split(r.stat.big(r.e));
    return {
      fallback, color,
      author_name: who, ...(icon ? { author_icon: icon } : {}),
      title: r.tie ? `🤝 TIED · ${levelName(r)}` : `${lv.icon} ${levelName(r)}`,
      text: `${allTime(r) ? "_all-time_\n" : ""}${what}\n*${r.stat.big(r.e)}*${sub ? `\n${sub}` : ""}`,
      fields: [{ title: oldTitle, value: oldVal, short: false }],
      // the same record as a picture (src/record-pics.js); records.js takes it off before sending a text card
      pic: { code: r.e.pool ? null : r.e.code, team: who, color, kind: `${r.tie ? "TIED · " : ""}${levelName(r)}`, allTime: allTime(r),
        what, n: num0, unit, sub, foot: [oldTitle, picOld], when: short(r.e.date), dom: null, wm: allTime(r) ? "SPARKY" : r.e.code },
    };
  };
  const domination = (e, fallback) => ({
    fallback, color: DOM_COLOR, author_name: fname(e.code), ...(logo(e.code) ? { author_icon: logo(e.code) } : {}),
    title: "💥 DOMINATION", text: `*${e.pts} point${e.pts === 1 ? "" : "s"}*\nThe other five combined: ${e.others}`,
    pic: { code: e.code, team: fname(e.code), color: DOM_COLOR, kind: "DOMINATION", allTime: false, what: "Outscored the other five franchises combined",
      n: String(e.pts), unit: e.pts === 1 ? "point" : "points", sub: "", foot: null, when: short(e.date), dom: { me: e.pts, rest: e.others }, wm: e.code },
  });
  return { record, domination };
}

// plain records for the record book and for Lens
const plain = (r) => ({
  stat: r.stat.key, label: r.stat.label, level: r.level, period: r.e.period, code: r.e.code, value: r.stat.val(r.e),
  text: r.stat.show(r.e), tie: r.tie, old: { value: r.old.v, holders: r.old.holders.slice(0, 3).map((o) => ({ code: o.code, date: o.date })), count: r.old.holders.length },
});

// ---- run ------------------------------------------------------------------------------------------------
// hist: history(nights); cur: current(...). Checks every night of `cur` whose date passes `want(date)`, in
// order; nights before or not wanted still join the marks. Returns { lines: {date: []}, records: {date: []},
// checked: [dates], marks }.
function run({ hist, cur, want, fname, prettyDate, logo = () => "" }) {
  DETAIL_ON = !!hist.detailComplete;
  const marks = new Marks();
  for (const e of hist.entries) marks.add(e);
  const { line, dom } = wording(fname, prettyDate);
  const card = cards(fname, prettyDate, logo);
  const byDate = {};
  for (const e of cur) (byDate[e.date] = byDate[e.date] || []).push(e);
  const out = { lines: {}, cards: {}, records: {}, checked: [], marks };
  const rank = { "pool-any": 0, "pool-n": 1, "fr-any": 2, "fr-n": 3 };
  for (const date of Object.keys(byDate).sort()) {
    const list = byDate[date];
    if (!want(date)) { for (const e of list) marks.add(e); continue; }
    const recs = checkNight(list, marks);
    recs.sort((a, b) => rank[a.level] - rank[b.level] || STATS.indexOf(a.stat) - STATS.indexOf(b.stat));
    const lines = [
      ...list.filter((e) => !e.pool && e.margin != null).map(dom),
      ...recs.map(line),
    ];
    out.lines[date] = lines;
    const doms = list.filter((e) => !e.pool && e.margin != null);
    const dc = doms.map((e) => card.domination(e, dom(e))), rc = recs.map((r) => card.record(r, line(r)));
    out.cards[date] = [...dc, ...rc];
    // for Lens (data/records/lens.json): each one with its picture layout, which Lens draws as its own card
    out.records[date] = { dominations: doms.map((e, i) => ({ code: e.code, pts: e.pts, others: e.others, pic: dc[i].pic })), records: recs.map((r, i) => ({ ...plain(r), pic: rc[i].pic })) };
    out.checked.push(date);
  }
  return out;
}

// the current marks, for Lens: { stat: { label, pool: { any, n: { N: mark } }, fr: { CODE: { any, n } } } }
function book(marks) {
  const out = {};
  const mk = (x) => ({ value: x.v, holders: x.holders.slice(0, 3).map((o) => ({ code: o.pool ? null : o.code, date: o.date })), count: x.holders.length });
  for (const [key, x] of marks.m) {
    const [stat, kind, a, b] = key.split("|");
    const s = (out[stat] = out[stat] || { label: (STATS.find((t) => t.key === stat) || {}).label, pool: { any: null, n: {} }, fr: {} });
    if (kind === "P" || kind === "L") { if (a) s.pool.n[a] = mk(x); else s.pool.any = mk(x); }
    else if (kind === "F") {
      const f = (s.fr[a] = s.fr[a] || { any: null, n: {} });
      if (b) f.n[b] = mk(x); else f.any = mk(x);
    }
  }
  return out;
}

module.exports = { history, current, run, book, STATS, MIN_GP, POOL_MIN_GP };
