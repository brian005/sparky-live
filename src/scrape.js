// ============================================================
// FANTRAX LIVE SCORING SCRAPER
// ============================================================
// Logs into Fantrax, navigates to live scoring page,
// extracts all 6 team cards from the sidebar.
// ============================================================

const puppeteer = require("puppeteer");

const FANTRAX_LOGIN_URL = "https://www.fantrax.com/login";
const LEAGUE_ID = "264ojs1imd3nogmp";

// Build live scoring URL for a given period
function buildLiveScoringUrl(period) {
  return `https://www.fantrax.com/fantasy/league/${LEAGUE_ID}/livescoring;period=${period};viewType=1`;
}

// Build standings URL (By Period view)
function buildStandingsUrl() {
  return `https://www.fantrax.com/fantasy/league/${LEAGUE_ID}/standings`;
}

/**
 * Launch browser, login, scrape live scoring data.
 * Returns: {
 *   scrapedAt: ISO timestamp,
 *   period: number,
 *   teams: [
 *     { rank: 1, name: "Jason's Gaucho Chudpumpers", seasonPts: 771, dayPts: 0, projectedFpg: 11.11 },
 *     ...
 *   ]
 * }
 */
async function scrapeLiveScoring({ username, password, period, headless = true }) {
  console.log(`[scrape] Launching browser (headless: ${headless})...`);

  const browser = await puppeteer.launch({
    headless: headless ? "new" : false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    // Step 1: Login
    console.log("[scrape] Navigating to login page...");
    await page.goto(FANTRAX_LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for login form
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="mail"]', { timeout: 15000 });

    // Find and fill email/username field
    const emailInput = await page.$('input[type="email"]') ||
                       await page.$('input[name="email"]') ||
                       await page.$('input[placeholder*="mail"]');
    if (!emailInput) throw new Error("Could not find email input field");

    await emailInput.click({ clickCount: 3 });
    await emailInput.type(username, { delay: 50 });

    // Find and fill password field
    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) throw new Error("Could not find password input field");

    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(password, { delay: 50 });

    // Click login button
    const loginButton = await page.$('button[type="submit"]') ||
                        await page.$('button.login-btn') ||
                        await page.$('button:has-text("Log In")');
    if (loginButton) {
      await loginButton.click();
    } else {
      // Fallback: press Enter
      await passwordInput.press("Enter");
    }

    // Wait for navigation after login
    console.log("[scrape] Logging in...");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {
      console.log("[scrape] Navigation timeout after login — continuing anyway...");
    });

    // Verify login succeeded by checking we're not still on the login page
    const currentUrl = page.url();
    if (currentUrl.includes("/login")) {
      throw new Error("Login failed — still on login page. Check credentials.");
    }
    console.log("[scrape] Login successful.");

    // Step 2: Navigate to live scoring
    const liveUrl = buildLiveScoringUrl(period);
    console.log(`[scrape] Navigating to live scoring: ${liveUrl}`);
    await page.goto(liveUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for team cards to render (Angular app)
    console.log("[scrape] Waiting for team cards to render...");
    await page.waitForSelector("section.matchup-list", { timeout: 20000 });

    // Give Angular a moment to fully populate
    await new Promise(r => setTimeout(r, 2000));

    // Step 3: Extract team data from sidebar
    console.log("[scrape] Extracting team data...");
    const teams = await page.evaluate(() => {
      const sections = document.querySelectorAll("section.matchup-list");
      const results = [];

      sections.forEach((section, index) => {
        // Team name
        const nameEl = section.querySelector("h4.matchup-list__name");
        const name = nameEl ? nameEl.textContent.trim() : `Unknown Team ${index + 1}`;

        // Season score — look in the score-primary header
        const primaryHeader = section.querySelector("header.matchup-list__score-primary");
        let seasonPts = 0;
        let dayPts = 0;

        if (primaryHeader) {
          // The primary header contains the main score values
          // Try to extract season and day scores from the header content
          const scoreTexts = primaryHeader.querySelectorAll("*");
          const numbers = [];
          scoreTexts.forEach(el => {
            const text = el.textContent.trim();
            const num = parseFloat(text);
            if (!isNaN(num) && text === String(num)) {
              numbers.push(num);
            }
          });
          if (numbers.length >= 1) seasonPts = numbers[0];
          if (numbers.length >= 2) dayPts = numbers[1];
        }

        // Fallback: look for score values more broadly in the section link
        if (seasonPts === 0) {
          const link = section.closest("a") || section.querySelector("a");
          if (link) {
            const allText = link.textContent;
            const nums = allText.match(/\d+\.?\d*/g);
            if (nums && nums.length >= 1) seasonPts = parseFloat(nums[0]);
          }
        }

        // Secondary score (projected FP/G or similar)
        const secondaryEl = section.querySelector("h3.matchup-list__score-secondary");
        const projectedFpg = secondaryEl ? parseFloat(secondaryEl.textContent.trim()) || 0 : 0;

        results.push({
          rank: index + 1,
          name,
          seasonPts,
          dayPts,
          projectedFpg
        });
      });

      return results;
    });

    if (teams.length === 0) {
      // Try alternate selectors
      console.log("[scrape] No teams found with primary selectors, trying fallback...");
      const fallbackTeams = await page.evaluate(() => {
        const wrapper = document.querySelector(".matchup-list_wrapper, .matchup-list__wrapper");
        if (!wrapper) return [];

        const links = wrapper.querySelectorAll("a[role='link']");
        const results = [];

        links.forEach((link, index) => {
          const nameEl = link.querySelector("h4");
          const name = nameEl ? nameEl.textContent.trim() : `Unknown ${index + 1}`;

          const text = link.textContent;
          const numbers = text.match(/[\d,]+\.?\d*/g) || [];
          const parsed = numbers.map(n => parseFloat(n.replace(/,/g, "")));

          results.push({
            rank: index + 1,
            name,
            seasonPts: parsed[0] || 0,
            dayPts: parsed[1] || 0,
            projectedFpg: parsed[2] || 0
          });
        });

        return results;
      });

      if (fallbackTeams.length > 0) {
        console.log(`[scrape] Fallback found ${fallbackTeams.length} teams.`);
        return {
          scrapedAt: new Date().toISOString(),
          period,
          teams: fallbackTeams
        };
      }

      // Last resort: screenshot for debugging
      await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
      throw new Error("Could not extract team data. Debug screenshot saved.");
    }

    console.log(`[scrape] Found ${teams.length} teams.`);
    return {
      scrapedAt: new Date().toISOString(),
      period,
      teams
    };

  } finally {
    await browser.close();
  }
}

/**
 * Scrape the cumulative standings page for additional stats.
 * Returns: { teams: [{ name, FPts, FP_G, GP, ... }] }
 */
async function scrapeStandings({ username, password, page: existingPage }) {
  // This can be called with an existing logged-in page to avoid double login
  const url = buildStandingsUrl();
  const page = existingPage;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("table, .standings-table", { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  const standings = await page.evaluate(() => {
    const rows = document.querySelectorAll("table tbody tr, .standings-row");
    const results = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll("td, .cell");
      if (cells.length < 4) return;

      const nameEl = row.querySelector("a, .team-name, h4");
      const name = nameEl ? nameEl.textContent.trim() : "";

      const values = Array.from(cells).map(c => c.textContent.trim());

      results.push({
        name,
        rawValues: values
      });
    });

    return results;
  });

  return standings;
}

module.exports = { scrapeLiveScoring, scrapeStandings, buildLiveScoringUrl };
