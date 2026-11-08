// ============================================================
// RECORD PICTURES: Screech's records as pictures in Sparky chat
// ============================================================
// Used by src/records.js. One 400 x 240 card a record (drawn at 2x: an 800 x 480 PNG), made from HTML by
// headless Chrome on the command line (the GitHub runner's google-chrome: no npm install). The PNGs are committed
// and pushed to this repo (it's public), then posted as Markdown images at raw.githubusercontent.com, pinned to
// that commit. Why that shows in F2's chat panel (sparkypool.ca/app/chatapp.js): Mattermost lists a post's
// images in post.metadata.images, and the panel's picsHtml draws each one 330 px wide (at most 330 x 420), while
// its md() drops the ![](...) text. Mattermost hands that list back with its keys sorted, so the file names carry
// the order (-01, -02, ...).
// Anything that fails here (no Chrome, a push that won't go, a picture GitHub won't serve yet) throws, and
// records.js posts the text cards instead, as before.
// Pictures older than KEEP_DAYS leave the tree in the same commit (about 190 KB each, and every workflow checks
// out the tree); their posts keep working, because each URL is pinned to the commit that added it.
//
// A picture (records.js and night-records.js make them):
//   { code, team, color, kind, allTime, what, n, unit, sub, foot: [label, value] | null, when,
//     dom: { me, rest } | null }
//   code      the franchise ("BEW"), or null for the whole league's own records ("Sparky record", the Sparky logo)
//   wm        the watermark, a big faded logo cut off by the bottom-right corner: a franchise's code (its own records,
//             a DOMINATION) or "SPARKY" (every all-time record) (Brian, 2026-11-08)
//   kind      the record's name ("P3 FRANCHISE RECORD", "TIED · SPARKY RECORD", "DOMINATION")
//   what      what it's a record for ("Most power-play points in a Period 3 night")
//   n, unit   the number and its unit ("8", "power-play points"); sub: a line under the unit
//   foot      the old mark, or the nights it ties ("Old mark", "7 · Nov 1, 2018"; "Ties 4 other nights", "")
//   when      top right: the night ("Nov 3") or the period ("Period 3 · 2026-27")
//
// Env:
//   CHROME_BIN              headless Chrome (default: the first of google-chrome, google-chrome-stable, chromium,
//                           chromium-browser found)
//   GITHUB_REPOSITORY       owner/repo for the picture URLs (Actions sets it; default brian005/sparky-live)
//   RECORD_PICS_URL_BASE    offline tests only: skip git, and a picture's URL is this + its repo path
// ============================================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FONTS = path.join(ROOT, "assets", "fonts");
const W = 400, H = 240, SCALE = 2;
const SPARKY = path.join(ROOT, "assets", "sparky-logo.png");   // the league's S, see-through (cut from Brian's art, 2026-11-08)
let sparkyUri = null;
const sparky = () => sparkyUri || (sparkyUri = fs.existsSync(SPARKY) ? `data:image/png;base64,${fs.readFileSync(SPARKY).toString("base64")}` : "");
const KEEP_DAYS = 14;

// ---- Chrome ----------------------------------------------------------------------------------------------
function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
      const f = path.join(dir, name);
      if (dir && fs.existsSync(f)) return f;
    }
  }
  throw new Error("no headless Chrome found (set CHROME_BIN)");
}

// ---- the card --------------------------------------------------------------------------------------------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let fontCss = null;
function fonts() {
  if (fontCss) return fontCss;
  const face = (fam, file, w, st = "normal") =>
    `@font-face{font-family:'${fam}';src:url(data:font/woff2;base64,${fs.readFileSync(path.join(FONTS, file)).toString("base64")}) format('woff2');font-weight:${w};font-style:${st}}`;
  fontCss = [
    face("Barlow Condensed", "barlow-condensed-900-italic.woff2", 900, "italic"),
    face("Barlow Condensed", "barlow-condensed-800.woff2", 800),
    face("Poppins", "poppins-400.woff2", 400),
    face("Poppins", "poppins-600.woff2", 600),
    face("Poppins", "poppins-700.woff2", 700),
  ].join("\n");
  return fontCss;
}

function cardHtml(p, logos = {}) {
  const c = /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : "#5B6B8C";
  const logo = p.code ? logos[p.code] : sparky();
  const badge = logo ? `<img${p.code ? "" : ' class="sp"'} src="${esc(logo)}">` : `<span class="badge">${esc(p.code || "S")}</span>`;
  const wmSrc = p.wm === "SPARKY" ? sparky() : p.wm ? logos[p.wm] : "";
  const wm = wmSrc ? `<img class="wm${p.wm === "SPARKY" ? " sp" : ""}" src="${esc(wmSrc)}">` : "";
  const small = (s, n) => (String(s || "").length > n ? " sm" : "");
  const dom = p.dom ? (() => {
    const m = Math.max(p.dom.me, p.dom.rest, 1);
    return `<div class="dom">
      <div class="row"><em>${esc(p.code)}</em><span class="t"><i style="width:${((p.dom.me / m) * 100).toFixed(1)}%;background:${c}"></i></span><b>${esc(p.dom.me)}</b></div>
      <div class="row"><em>The other five</em><span class="t"><i style="width:${((p.dom.rest / m) * 100).toFixed(1)}%;background:#5B6B88"></i></span><b>${esc(p.dom.rest)}</b></div></div>`;
  })() : "";
  const foot = !p.dom && p.foot && p.foot[0]
    ? `<div class="foot${String(p.foot[0]).length + String(p.foot[1] || "").length > 46 ? " sm" : ""}"><i>${esc(p.foot[0])}</i>${p.foot[1] ? `<span>${esc(p.foot[1])}</span>` : ""}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fonts()}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#0B1222}
.card{position:relative;width:${W}px;height:${H}px;overflow:hidden;color:#fff;font-family:Poppins,sans-serif;
  background:radial-gradient(340px 210px at 92% -12%, ${c}38, transparent 70%),linear-gradient(160deg,#121C33,#0B1222 70%)}
.bar{position:absolute;left:0;top:0;bottom:0;width:7px;background:${c};box-shadow:0 0 16px ${c}}
.top{position:absolute;left:22px;right:16px;top:15px;display:flex;align-items:center;gap:10px}
.top img,.top .badge{width:40px;height:40px;border-radius:10px;object-fit:cover;flex:none;box-shadow:0 0 0 2px ${c}88}
.top .badge{display:flex;align-items:center;justify-content:center;background:#1C2A45;font:800 14px/1 'Barlow Condensed';letter-spacing:.5px;color:${c}}
.top img.sp{object-fit:contain;background:#0B1222;padding:4px}
.wm{position:absolute;right:-58px;bottom:-74px;width:260px;height:260px;object-fit:cover;opacity:.15;
  -webkit-mask-image:radial-gradient(closest-side,#000 62%,transparent 100%);mask-image:radial-gradient(closest-side,#000 62%,transparent 100%)}
.wm.sp{object-fit:contain;opacity:.13;-webkit-mask-image:none;mask-image:none;transform:rotate(-8deg)}
.top .nm{font-weight:600;font-size:15px;line-height:1.15;flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.top .dt{font-size:12.5px;color:#9AABC8;white-space:nowrap;align-self:flex-start;margin-top:2px}
.kind{position:absolute;left:22px;right:16px;top:66px;display:flex;align-items:center;gap:8px;white-space:nowrap}
.kind b{font:900 italic 25px/1 'Barlow Condensed';letter-spacing:.3px;color:${c};text-shadow:0 0 12px ${c}66}
.kind b.sm{font-size:22px}
.kind i{font:800 11px/1 'Barlow Condensed';letter-spacing:.8px;font-style:normal;color:#0B1222;background:${c};border-radius:4px;padding:3px 5px 2px}
.what{position:absolute;left:22px;right:16px;top:94px;font-size:13.5px;color:#B4C2DA;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.what.sm{font-size:12.2px}
.num{position:absolute;left:18px;right:16px;top:110px;display:flex;align-items:flex-end;gap:10px}
.num b{font:900 italic 92px/.9 'Barlow Condensed';letter-spacing:-1px;padding-right:4px;flex:none}
.num .u{padding-bottom:9px;min-width:0;flex:1}
.num .u span{display:block;font-weight:600;font-size:18px;color:#E6EEFA;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.num .u small{display:block;font-size:13px;color:#9AABC8;margin-top:1px;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.foot{position:absolute;left:22px;max-width:362px;bottom:15px;display:inline-flex;align-items:center;gap:9px;padding:6px 11px;border-radius:9px;background:rgba(255,255,255,.08)}
.foot i{font:800 13.5px/1 'Barlow Condensed';letter-spacing:.7px;color:#9AABC8;font-style:normal;text-transform:uppercase;white-space:nowrap;flex:none}
.foot span{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.foot.sm i{font-size:12px}
.foot.sm span{font-size:11.5px}
.card.d .num b{font-size:72px}
.card.d .num .u{padding-bottom:6px}
.dom{position:absolute;left:22px;right:20px;bottom:15px}
.dom .row{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px}
.dom .row em{font-style:normal;width:96px;color:#B4C2DA;white-space:nowrap;font-size:12.5px}
.dom .row .t{flex:1;height:13px;border-radius:7px;background:rgba(255,255,255,.07);overflow:hidden}
.dom .row .t i{display:block;height:100%;border-radius:7px}
.dom .row b{width:18px;text-align:right;font-weight:700}
</style></head><body><div class="card${p.dom ? " d" : ""}"><div class="bar"></div>
${wm}<div class="top">${badge}<div class="nm">${esc(p.team)}</div>${p.when ? `<div class="dt">${esc(p.when)}</div>` : ""}</div>
<div class="kind"><b class="${small(p.kind, 24).trim()}">${esc(p.kind)}</b>${p.allTime ? "<i>ALL-TIME</i>" : ""}</div>
<div class="what${small(p.what, 46)}">${esc(p.what)}</div>
<div class="num"><b>${esc(p.n)}</b><div class="u"><span>${esc(p.unit)}</span>${p.sub ? `<small>${esc(p.sub)}</small>` : ""}</div></div>
${dom}${foot}
</div></body></html>`;
}

// render(pics, { logos, dir, stamp }) -> [{ file, rel }]: one PNG a picture, named <stamp>-01.png, -02, ... in dir
function render(pics, { logos = {}, dir, stamp }) {
  const bin = chromeBin();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "record-pics-"));
  const out = [];
  try {
    pics.forEach((p, i) => {
      const name = `${stamp}-${String(i + 1).padStart(2, "0")}`;
      const html = path.join(tmp, `${name}.html`), file = path.join(dir, `${name}.png`);
      fs.writeFileSync(html, cardHtml(p, logos));
      if (fs.existsSync(file)) fs.unlinkSync(file);
      execFileSync(bin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions",
        `--force-device-scale-factor=${SCALE}`, `--window-size=${W},${H}`, "--virtual-time-budget=3000",
        `--screenshot=${file}`, `file://${html}`], { stdio: "pipe", timeout: 60000 });
      if (!fs.existsSync(file) || fs.statSync(file).size < 2000) throw new Error(`Chrome made no picture for ${name}`);
      out.push({ file, rel: path.relative(ROOT, file).split(path.sep).join("/") });
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return out;
}

// ---- publishing ------------------------------------------------------------------------------------------
const git = (...a) => execFileSync("git", a, { cwd: ROOT, stdio: "pipe", encoding: "utf8", timeout: 120000 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// publish(files, message) -> the pictures' URLs, in order. Commits and pushes them (GitHub Actions only), then
// waits until GitHub serves every one, since Mattermost reads them the moment the post goes in.
async function publish(files, message) {
  if (process.env.RECORD_PICS_URL_BASE) return files.map((f) => `${process.env.RECORD_PICS_URL_BASE.replace(/\/+$/, "")}/${f.rel}`);
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("pictures are published from GitHub Actions only");
  git("add", "--", ...files.map((f) => f.rel));
  const dir = path.dirname(files[0].file), cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const old = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.png$/.test(f) && f.slice(0, 10) < cutoff)
    .map((f) => path.relative(ROOT, path.join(dir, f)).split(path.sep).join("/"));
  if (old.length) git("rm", "-q", "--ignore-unmatch", "--", ...old);
  git("-c", "user.name=sparkybot", "-c", "user.email=sparkybot@users.noreply.github.com", "commit", "--quiet", "-m", message);
  let pushed = false, why = "";
  for (let i = 0; i < 4 && !pushed; i++) {
    try { git("pull", "--rebase", "--autostash", "--quiet"); git("push", "--quiet"); pushed = true; }
    catch (e) { why = String(e.stderr || e.message).trim().split("\n").pop(); await sleep(5000 * (i + 1)); }
  }
  if (!pushed) throw new Error(`push failed: ${why}`);
  const sha = git("rev-parse", "HEAD");
  const repo = process.env.GITHUB_REPOSITORY || "brian005/sparky-live";
  const urls = files.map((f) => `https://raw.githubusercontent.com/${repo}/${sha}/${f.rel}`);
  const until = Date.now() + 90000;
  for (const u of urls) {
    for (;;) {
      let ok = false;
      try { const r = await fetch(u, { method: "HEAD" }); ok = r.ok; } catch (e) {}
      if (ok) break;
      if (Date.now() > until) throw new Error(`GitHub isn't serving ${u} yet`);
      await sleep(3000);
    }
  }
  return urls;
}

module.exports = { render, publish, cardHtml, chromeBin };
