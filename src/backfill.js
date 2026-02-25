// ============================================================
// BACKFILL DAILY SCORES
// ============================================================
// One-time script to populate data/daily/ with historical data.
// Logs into Fantrax once, then iterates through every date in
// the season, scraping each day's scores.
//
// Usage:
//   node src/backfill.js                    # Full season backfill
//   node src/backfill.js --from 2026-01-26  # Start from specific date
//   node src/backfill.js --date 2026-02-05  # Single date only
//   node src/backfill.js --dry-run          # Log what would be scraped
//
// Env vars: FANTRAX_USERNAME, FANTRAX_PASSWORD
// Optional: HEADLESS=false for debugging, DELAY=5000 (ms between pages)
// ============================================================

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const fs = require("fs");
const path = require("path");
const { getAllSeasonDates, buildDateScoringUrl, toFranchise } = require("./config");

const DAILY_DIR = path.join(__dirname, "..", "data", "daily");
const DELAY = parseInt(process.env.DELAY) || 8000;

/**
 * Login to Fantrax — reuses the same proven login flow from scrape.js.
 * Returns the logged-in page object.
 */
async function login(browser, username, password) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );

  console.log("[login] Navigating to login page...");
  await page.goto("https://www.fantrax.com/login", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Open dialog if needed
  let dialogOpen = await page.$("mat-dialog-container, .mat-mdc-dialog-container");
  if (!dialogOpen) {
    console.log("[login] Clicking Login button...");
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, a"));
      const btn = buttons.find(b => b.textContent.trim().toLowerCase() === "login");
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 2000));
  }

  // Wait for inputs
  try {
    await page.waitForSelector("mat-dialog-container input, .mat-mdc-dialog-container input, .mat-mdc-form-field input, input.mat-mdc-input-element", { timeout: 15000 });
  } catch (e) {
    await page.screenshot({ path: "debug-backfill-login.png", fullPage: true });
    const info = await page.evaluate(() => ({
      url: window.location.href,
      inputCount: document.querySelectorAll("input").length,
      hasDialog: !!document.querySelector("mat-dialog-container"),
      bodySnippet: document.body.innerText.substring(0, 300)
    }));
    throw new Error("Login dialog inputs not found. Info: " + JSON.stringify(info));
  }

  // Fill credentials
  const allInputs = await page.$$("mat-dialog-container input, .mat-mdc-dialog-container input");
  let emailInput, passwordInput;
  if (allInputs.length >= 2) {
    emailInput = allInputs[0];
    passwordInput = allInputs[1];
  } else {
    // Broader fallback
    const textInputs = await page.$$('input[type="text"], input[type="email"], input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])');
    passwordInput = await page.$('input[type="password"]');
    emailInput = textInputs.length > 0 ? textInputs[0] : null;
  }

  if (!emailInput || !passwordInput) {
    await page.screenshot({ path: "debug-backfill-login.png", fullPage: true });
    const inputInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input")).map(i => ({
        type: i.type, id: i.id, className: i.className.substring(0, 60)
      }));
    });
    throw new Error("Could not find login inputs. Found: " + JSON.stringify(inputInfo));
  }

  await emailInput.click({ clickCount: 3 });
  await emailInput.type(username, { delay: 30 });
  await new Promise(r => setTimeout(r, 500));

  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(password, { delay: 30 });
  await new Promise(r => setTimeout(r, 500));

  // Click Login
  const clicked = await page.evaluate(() => {
    const dialogActions = document.querySelector("mat-dialog-actions, .mat-mdc-dialog-actions, .mat-dialog-actions");
    if (dialogActions) {
      for (const btn of dialogActions.querySelectorAll("button")) {
        if (btn.textContent.trim().toLowerCase().includes("login")) { btn.click(); return true; }
      }
    }
    for (const btn of document.querySelectorAll("button")) {
      if (btn.textContent.trim().toLowerCase() === "login" && btn.offsetParent !== null) { btn.click(); return true; }
    }
    return false;
  });
  if (!clicked) await passwordInput.press("Enter");

  console.log("[login] Waiting for login...");
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  const url = page.url();
  if (url.includes("/login")) {
    await page.screenshot({ path: "debug-backfill-login.png", fullPage: true });
    throw new Error("Login failed — still on login page.");
  }

  console.log("[login] Success.");
  return page;
}

/**
 * Scrape a single date's scoring data from the live scoring page.
 * Uses DOM stability detection to ensure the Angular SPA has fully
 * rendered the target date's data before scraping.
 */
async function scrapeDate(page, dateStr, period, prevFingerprint) {
  const url = buildDateScoringUrl(dateStr);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Wait for cards to appear in DOM
  try {
    await page.waitForSelector("section.matchup-list", { timeout: 15000 });
  } catch (e) {
    console.log(`  [${dateStr}] No team cards found — checking page...`);
    await page.screenshot({ path: `debug-backfill-${dateStr}.png`, fullPage: true });
    return { data: null, fingerprint: prevFingerprint };
  }

  // --- SPA data-change detection ---
  // The cards exist in the DOM from the previous page load. We need to
  // wait until the Angular SPA has re-fetched and rendered the NEW date's
  // data. We do this by fingerprinting the visible scores and waiting
  // until (a) they differ from the previous page's fingerprint, and
  // (b) they stabilize across consecutive polls.
  const getFingerprint = () => page.evaluate(() => {
    const sections = document.querySelectorAll("section.matchup-list");
    return Array.from(sections).map(s => {
      const h2s = Array.from(s.querySelectorAll("h2"));
      return h2s.map(h => h.textContent.trim()).join(",");
    }).join("|");
  });

  let fingerprint = "";
  let stableCount = 0;
  const maxAttempts = 15; // up to 15 seconds of polling
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const current = await getFingerprint();
    
    // Check: has data changed from previous date AND stabilized?
    const changedFromPrev = !prevFingerprint || current !== prevFingerprint;
    if (current === fingerprint && current.length > 0) {
      stableCount++;
      if (changedFromPrev && stableCount >= 2) {
        break; // Data changed from prev page and stable for 2+ checks
      }
    } else {
      fingerprint = current;
      stableCount = 0;
    }
    
    if (i === maxAttempts - 1) {
      console.log(`  [${dateStr}] ⚠️  DOM did not change/stabilize after ${maxAttempts}s — scraping current state`);
      // This can happen legitimately on consecutive no-game days
      // where the fingerprint is truly the same
    }
  }

  // Extra buffer for any trailing renders
  await new Promise(r => setTimeout(r, 1000));

  // Extract team data
  const teams = await page.evaluate(() => {
    const sections = document.querySelectorAll("section.matchup-list");
    const results = [];

    sections.forEach((section, index) => {
      const nameEl = section.querySelector("h4.matchup-list__name");
      const name = nameEl ? nameEl.textContent.trim() : `Unknown Team ${index + 1}`;

      // Debug: dump all h2 and h3 elements in this section
      const h2s = Array.from(section.querySelectorAll("h2")).map(el => ({
        class: el.className,
        text: el.textContent.trim()
      }));
      const h3s = Array.from(section.querySelectorAll("h3")).map(el => ({
        class: el.className,
        text: el.textContent.trim()
      }));

      // Day score — h2 text is like "Day 9" or "Day\n9"
      const dayEl = section.querySelector("h2.matchup-list__score-primary--alt") ||
                    section.querySelector("[class*='score-primary--alt']");
      let dayPts = 0;
      if (dayEl) {
        const nums = dayEl.textContent.match(/[\d.]+/g);
        if (nums && nums.length > 0) dayPts = parseFloat(nums[nums.length - 1]) || 0;
      }

      // Projected points
      const projEl = section.querySelector("h3.matchup-list__score-secondary");
      let projPts = 0;
      if (projEl) {
        const nums = projEl.textContent.match(/[\d.]+/g);
        if (nums && nums.length > 0) projPts = parseFloat(nums[nums.length - 1]) || 0;
      }

      // GP
      let gp = 0;
      const infoEl = section.querySelector(".matchup-list__roster-info, .roster-info");
      if (infoEl) {
        const nums = infoEl.textContent.match(/\d+/g);
        if (nums && nums.length >= 1) gp = parseInt(nums[0]);
      }

      results.push({
        rank: index + 1,
        name,
        dayPts,
        projPts,
        gp,
        _debug: { h2s, h3s, dayElClass: dayEl ? dayEl.className : "NOT FOUND" }
      });
    });

    return results;
  });

  // Log debug info for first team
  if (teams.length > 0) {
    console.log(`  [${dateStr}] Debug first team:`, JSON.stringify(teams[0]._debug, null, 2));
  }

  // Strip debug before saving
  const cleanTeams = teams.map(({ _debug, ...rest }) => rest);

  if (cleanTeams.length === 0) return { data: null, fingerprint };

  return {
    data: {
      date: dateStr,
      period,
      teams: cleanTeams.map(t => ({
        franchise: toFranchise(t.name) || t.name,
        name: t.name,
        dayPts: t.dayPts,
        projPts: t.projPts,
        gp: t.gp,
      }))
    },
    fingerprint
  };
}

/**
 * Save a daily score file.
 */
function saveDailyFile(data) {
  if (!fs.existsSync(DAILY_DIR)) {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
  }
  const filepath = path.join(DAILY_DIR, `${data.date}.json`);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

// ---- Main ----

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const singleDate = args.find((_, i) => args[i - 1] === "--date");
  const fromDate = args.find((_, i) => args[i - 1] === "--from");

  const username = process.env.FANTRAX_USERNAME;
  const password = process.env.FANTRAX_PASSWORD;
  if (!username || !password) {
    console.error("❌ FANTRAX_USERNAME and FANTRAX_PASSWORD required.");
    process.exit(1);
  }

  // Build date list
  let dates = getAllSeasonDates();

  if (singleDate) {
    dates = dates.filter(d => d.date === singleDate);
    if (dates.length === 0) {
      console.error(`❌ Date ${singleDate} not found in season schedule.`);
      process.exit(1);
    }
  } else if (fromDate) {
    dates = dates.filter(d => d.date >= fromDate);
  }

  // Skip dates we already have (unless --force)
  const existing = new Set();
  if (!force && fs.existsSync(DAILY_DIR)) {
    fs.readdirSync(DAILY_DIR).forEach(f => {
      if (f.endsWith(".json")) existing.add(f.replace(".json", ""));
    });
  }

  const toScrape = dates.filter(d => !existing.has(d.date));
  const skipped = dates.length - toScrape.length;

  console.log(`\n📊 SPARKY LIVE — BACKFILL`);
  console.log(`   Total season dates: ${dates.length}`);
  console.log(`   Already scraped:    ${skipped}`);
  console.log(`   To scrape:          ${toScrape.length}`);
  console.log(`   Delay between:      ${DELAY}ms`);
  console.log(`   Est. time:          ${Math.round(toScrape.length * (DELAY + 5000) / 60000)} min (incl. SPA wait)\n`);

  if (toScrape.length === 0) {
    console.log("✅ Nothing to backfill — all dates already scraped.");
    return;
  }

  if (dryRun) {
    console.log("DRY RUN — dates that would be scraped:");
    toScrape.forEach(d => console.log(`  ${d.date} (P${d.period})`));
    return;
  }

  // Launch browser and login once
  const headless = process.env.HEADLESS !== "false";
  console.log(`Launching browser (headless: ${headless})...`);

  const browser = await puppeteer.launch({
    headless: headless ? "new" : false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  try {
    const page = await login(browser, username, password);

    // Configure git for batch commits
    try {
      const { execSync } = require("child_process");
      execSync('git config user.name "SparkyBot"', { stdio: "pipe" });
      execSync('git config user.email "sparkybot@users.noreply.github.com"', { stdio: "pipe" });
    } catch (e) { /* not in a git repo, skip batch commits */ }

    let success = 0;
    let failures = 0;
    const BATCH_SIZE = 20;
    let prevFingerprint = null;

    for (let i = 0; i < toScrape.length; i++) {
      const { date, period } = toScrape[i];
      const progress = `[${i + 1}/${toScrape.length}]`;

      try {
        process.stdout.write(`${progress} ${date} (P${period})... `);

        const result = await scrapeDate(page, date, period, prevFingerprint);
        const data = result ? result.data : null;
        prevFingerprint = result ? result.fingerprint : prevFingerprint;

        if (data && data.teams.length > 0) {
          const filepath = saveDailyFile(data);
          const totalPts = data.teams.reduce((sum, t) => sum + t.dayPts, 0);
          const teamSummary = data.teams.map(t => `${t.franchise}:${t.dayPts}`).join(" ");
          console.log(`✅ ${data.teams.length} teams, ${totalPts.toFixed(1)} total pts [${teamSummary}]`);
          success++;
        } else {
          console.log(`⚠️  No data (possibly no games)`);
          // Save empty file so we don't retry
          saveDailyFile({ date, period, teams: [] });
          success++;
        }
      } catch (err) {
        console.log(`❌ ${err.message}`);
        failures++;
      }

      // Batch commit every N dates to save progress
      if ((i + 1) % BATCH_SIZE === 0 || i === toScrape.length - 1) {
        try {
          const { execSync } = require("child_process");
          execSync(`git add data/daily/ && git diff --staged --quiet || git commit -m "📊 Backfill batch: ${i + 1}/${toScrape.length}"`, { stdio: "pipe" });
          execSync("git push", { stdio: "pipe" });
          console.log(`  💾 Committed & pushed (${i + 1}/${toScrape.length})`);
        } catch (gitErr) {
          console.log(`  ⚠️  Git commit skipped: ${gitErr.message.substring(0, 80)}`);
        }
      }

      // Delay between pages
      if (i < toScrape.length - 1) {
        await new Promise(r => setTimeout(r, DELAY));
      }
    }

    console.log(`\n━━━ BACKFILL COMPLETE ━━━`);
    console.log(`  Success:  ${success}`);
    console.log(`  Failures: ${failures}`);
    console.log(`  Files in: ${DAILY_DIR}`);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
