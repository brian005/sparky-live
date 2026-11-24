#!/usr/bin/env node
// Saves a signed-in Fantrax session for the janitor (src/f1-replicate.js) as the FANTRAX_COOKIES secret.
//
// Why (Nov 24 2026): since Nov 23 PM Fantrax shows a captcha challenge when the janitor signs in from a
// GitHub runner. The janitor must not try to get past a captcha, so a person signs in instead: this opens a
// real browser window on Brian's PC at Fantrax's login, he signs in (solving any captcha himself), and the
// session's cookies go straight into the repo secret through `gh secret set`. They never touch the disk or
// the screen. The janitor loads them before it tries the password; when they expire its error says to run
// this again.
//
// Run from the repo:  node src/fantrax-cookie.js            (needs gh signed in, and npm ci done)
// Options:            --repo owner/name   (default brian005/sparky-live)
//                     --chrome            use the installed Chrome instead of Puppeteer's own browser
"use strict";
const { spawnSync } = require("child_process");
const puppeteer = require("puppeteer");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REPO = opt("--repo", "brian005/sparky-live");
const LEAGUE = process.env.FANTRAX_LEAGUE_ID || "4lg9i7kvmo319aqr";
const FX = "https://www.fantrax.com";
const WAIT_MIN = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signedIn(page) {
  const r = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ msgs: [{ method: "getTeamRosterInfo", data: {} }], uiv: 3, refUrl: location.href, dt: 0, at: 0 }) });
      return await res.text();
    } catch (e) { return ""; }
  }, `/fxpa/req?leagueId=${LEAGUE}`).catch(() => "");
  try {
    const o = JSON.parse(r);
    const resp = (o.responses || [])[0] || {};
    return !o.pageError && !resp.pageError && !!resp.data;
  } catch (_) { return false; }
}

(async () => {
  const launch = { headless: false, defaultViewport: null, args: ["--window-size=1200,900"] };
  if (args.includes("--chrome")) launch.channel = "chrome";
  const browser = await puppeteer.launch(launch);
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto(`${FX}/login`, { waitUntil: "networkidle2" }).catch(() => {});
    console.log(`Sign in to Fantrax in the window that just opened (you have ${WAIT_MIN} minutes). Leave the window alone once you're in.`);

    const until = Date.now() + WAIT_MIN * 60000;
    let ok = false;
    while (Date.now() < until) {
      await sleep(3000);
      if (page.url().includes("/login")) continue;
      if (await signedIn(page)) { ok = true; break; }
    }
    if (!ok) { console.error("Not signed in after " + WAIT_MIN + " minutes; nothing saved."); process.exitCode = 1; return; }

    // every Fantrax cookie the browser holds, HttpOnly ones included
    const cdp = await page.target().createCDPSession();
    const { cookies } = await cdp.send("Network.getAllCookies");
    const jar = cookies
      .filter((c) => /fantrax\.com$/.test(String(c.domain).replace(/^\./, "")))
      // a session cookie (expires -1) goes without expires: set back with -1 it would arrive already expired
      .map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, httpOnly, secure, ...(expires > 0 ? { expires } : {}), ...(sameSite ? { sameSite } : {}) }));
    if (!jar.length) { console.error("No Fantrax cookies found; nothing saved."); process.exitCode = 1; return; }

    const longest = Math.max(...jar.map((c) => c.expires || 0));
    const gh = spawnSync("gh", ["secret", "set", "FANTRAX_COOKIES", "--repo", REPO], { input: JSON.stringify(jar), stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
    if (gh.status !== 0) { console.error("gh secret set failed; nothing saved."); process.exitCode = 1; return; }
    console.log(`Saved ${jar.length} Fantrax cookies to ${REPO} as FANTRAX_COOKIES.` +
      (longest > 0 ? ` The longest-lived one expires ${new Date(longest * 1000).toISOString().slice(0, 10)}.` : " They are session cookies with no set expiry."));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
