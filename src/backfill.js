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
const DELAY = parseInt(process.env.DELAY) || 5000;

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
 */
async function scrapeDate(page, dateStr, period) {
  const url = buildDateScoringUrl(dateStr);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Wait for cards
  try {
    await page.waitForSelector("section.matchup-list", { timeout: 15000 });
  } catch (e) {
    // Maybe no games that day — try to detect empty page
    console.log(`  [${dateStr}] No team cards found — checking page...`);
    await page.screenshot({ path: `debug-backfill-${dateStr}.png`, fullPage: true });
    return null;
  }

  await new Promise(r => setTimeout(r, 2000));

  // Extract team data
  const teams = await page.evaluate(() => {
    const sections = document.querySelectorAll("section.matchup-list");
    const results = [];

    sections.forEach((section, index) => {
      const nameEl = section.querySelector("h4.matchup-list__name");
      const name = nameEl ? nameEl.textContent.trim() : `Unknown Team ${index + 1}`;

      // Day score — in h2.matchup-list__score-primary--alt
      const dayEl = section.querySelector("h2.matchup-list__score-primary--alt");
      const dayPts = dayEl ? parseFloat(dayEl.textContent.trim()) || 0 : 0;

      // Projected points — in h3.matchup-list__score-secondary
      const projEl = section.querySelector("h3.matchup-list__score-secondary");
      const projPts = projEl ? parseFloat(projEl.textContent.trim()) || 0 : 0;

      // GP from roster info line
      let gp = 0;
      const rosterEls = section.querySelectorAll(".matchup-list__game-info, .player-game-info");
      // Fallback: look for the small text line with numbers like "13 0 0"
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
        gp
      });
    });

    return results;
  });

  if (teams.length === 0) return null;

  return {
    date: dateStr,
    period,
    teams: teams.map(t => ({
      franchise: toFranchise(t.name) || t.name,
      name: t.name,
      dayPts: t.dayPts,
      projPts: t.projPts,
      gp: t.gp,
    }))
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
  console.log(`   Est. time:          ${Math.round(toScrape.length * DELAY / 60000)} min\n`);

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

    let success = 0;
    let failures = 0;

    for (let i = 0; i < toScrape.length; i++) {
      const { date, period } = toScrape[i];
      const progress = `[${i + 1}/${toScrape.length}]`;

      try {
        process.stdout.write(`${progress} ${date} (P${period})... `);

        const data = await scrapeDate(page, date, period);

        if (data && data.teams.length > 0) {
          const filepath = saveDailyFile(data);
          const totalPts = data.teams.reduce((sum, t) => sum + t.dayPts, 0);
          console.log(`✅ ${data.teams.length} teams, ${totalPts.toFixed(1)} total pts`);
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
