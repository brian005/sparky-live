// ============================================================
// FANTRAX LIVE SCORING SCRAPER
// ============================================================
// Logs into Fantrax, navigates to live scoring page,
// extracts all 6 team cards from the sidebar.
// ============================================================

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const FANTRAX_LOGIN_URL = "https://www.fantrax.com/login";
const LEAGUE_ID = "264ojs1imd3nogmp";

// Build live scoring URL for a given date (YYYY-MM-DD)
function buildLiveScoringUrl(date) {
  return `https://www.fantrax.com/fantasy/league/${LEAGUE_ID}/livescoring;viewType=1;date=${date}`;
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
async function scrapeLiveScoring({ username, password, period, date, headless = true }) {
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
    // Fantrax uses an Angular Material dialog for login.
    // We navigate to /login, which may open the dialog automatically,
    // or we may need to click a Login button first.
    console.log("[scrape] Navigating to login page...");
    await page.goto(FANTRAX_LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for page to settle
    await new Promise(r => setTimeout(r, 3000));

    // Check if the login dialog is already open, or if we need to click a Login button
    let dialogOpen = await page.$("mat-dialog-container, .mat-mdc-dialog-container");
    if (!dialogOpen) {
      console.log("[scrape] Login dialog not open, looking for Login button...");
      // Try clicking a Login button on the page to open the dialog
      const loginTrigger = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, a"));
        const loginBtn = buttons.find(b => b.textContent.trim().toLowerCase() === "login");
        if (loginBtn) { loginBtn.click(); return true; }
        return false;
      });
      if (loginTrigger) {
        console.log("[scrape] Clicked Login button, waiting for dialog...");
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Wait for the Material dialog to appear with input fields
    try {
      await page.waitForSelector("mat-dialog-container input, .mat-mdc-dialog-container input, .mat-mdc-form-field input, input[matinput], input.mat-mdc-input-element", { timeout: 15000 });
    } catch (e) {
      await page.screenshot({ path: "debug-login-page.png", fullPage: true });
      // Log what's on the page for debugging
      const pageInfo = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        hasDialog: !!document.querySelector("mat-dialog-container"),
        inputCount: document.querySelectorAll("input").length,
        bodyText: document.body.innerText.substring(0, 500)
      }));
      throw new Error("Login dialog inputs not found. Page info: " + JSON.stringify(pageInfo));
    }

    console.log("[scrape] Login dialog found, filling credentials...");

    // Debug: log all input fields
    const inputInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input");
      return Array.from(inputs).map(i => ({
        type: i.type, name: i.name, id: i.id,
        placeholder: i.placeholder, className: i.className,
        ariaLabel: i.getAttribute("aria-label"),
        formFieldLabel: i.closest("mat-form-field, .mat-mdc-form-field") ?
          i.closest("mat-form-field, .mat-mdc-form-field").querySelector("mat-label, label")?.textContent?.trim() : null
      }));
    });
    console.log("[scrape] Found inputs:", JSON.stringify(inputInfo, null, 2));

    // Find all input fields inside the dialog
    // Fantrax uses Angular Material — inputs are inside mat-form-field elements
    // First field is email/username, second is password
    const allInputs = await page.$$("mat-dialog-container input, .mat-mdc-dialog-container input");

    // Fallback: if dialog selector didn't work, try broader match
    let emailInput, passwordInput;
    if (allInputs.length >= 2) {
      emailInput = allInputs[0];
      passwordInput = allInputs[1];
    } else {
      // Try by type
      const textInputs = await page.$$('input[type="text"], input[type="email"], input:not([type="password"]):not([type="hidden"])');
      passwordInput = await page.$('input[type="password"]');
      emailInput = textInputs.length > 0 ? textInputs[0] : null;
    }

    if (!emailInput) {
      await page.screenshot({ path: "debug-login-form.png", fullPage: true });
      throw new Error("Could not find email input. Inputs found: " + JSON.stringify(inputInfo));
    }
    if (!passwordInput) {
      await page.screenshot({ path: "debug-login-form.png", fullPage: true });
      throw new Error("Could not find password input. Inputs found: " + JSON.stringify(inputInfo));
    }

    // Fill credentials
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(username, { delay: 30 });
    await new Promise(r => setTimeout(r, 500));

    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(password, { delay: 30 });
    await new Promise(r => setTimeout(r, 500));

    // Click the Login button inside the dialog
    const loginClicked = await page.evaluate(() => {
      // Try multiple approaches to find the Login button
      // 1. Look in mat-dialog-actions (Material dialog footer)
      const dialogActions = document.querySelector("mat-dialog-actions, mat-mdc-dialog-actions, .mat-mdc-dialog-actions, .mat-dialog-actions");
      if (dialogActions) {
        const buttons = dialogActions.querySelectorAll("button");
        for (const btn of buttons) {
          if (btn.textContent.trim().toLowerCase().includes("login")) {
            btn.click();
            return "found in dialog-actions";
          }
        }
      }

      // 2. Look for any visible button with "Login" text
      const allButtons = document.querySelectorAll("button");
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (text === "login" && btn.offsetParent !== null) {
          btn.click();
          return "found by text match";
        }
      }

      // 3. Look for mat-raised-button or primary button inside dialog
      const dialog = document.querySelector("mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane");
      if (dialog) {
        const buttons = dialog.querySelectorAll("button");
        for (const btn of buttons) {
          if (btn.textContent.trim().toLowerCase().includes("login") ||
              btn.classList.contains("mat-primary") ||
              btn.classList.contains("mat-raised-button")) {
            btn.click();
            return "found in dialog container";
          }
        }
        // Last resort: click the last button in the dialog (usually the submit)
        if (buttons.length > 0) {
          buttons[buttons.length - 1].click();
          return "clicked last dialog button";
        }
      }

      return null;
    });

    if (loginClicked) {
      console.log(`[scrape] Clicked Login button (${loginClicked}).`);
    } else {
      // Fallback: press Enter
      console.log("[scrape] No Login button found, pressing Enter...");
      await passwordInput.press("Enter");
    }

    // Wait for navigation after login
    console.log("[scrape] Logging in...");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {
      console.log("[scrape] Navigation timeout after login — continuing anyway...");
    });

    // Give the page extra time to settle (Angular redirect can be slow)
    await new Promise(r => setTimeout(r, 5000));

    // Verify login succeeded
    const currentUrl = page.url();
    console.log("[scrape] Current URL after login: " + currentUrl);

    if (currentUrl.includes("/login")) {
      // Take a screenshot to see what happened (CAPTCHA? Wrong creds?)
      await page.screenshot({ path: "debug-login-failed.png", fullPage: true });
      throw new Error("Login failed — still on login page. Check credentials or reCAPTCHA may be blocking. Screenshot saved.");
    }
    console.log("[scrape] Login successful.");

    // Step 2: Navigate to live scoring for the specific date
    const liveUrl = buildLiveScoringUrl(date);
    console.log(`[scrape] Navigating to live scoring: ${liveUrl}`);
    await page.goto(liveUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for team cards to render (Angular app)
    console.log("[scrape] Waiting for team cards to render...");
    await page.waitForSelector("section.matchup-list", { timeout: 20000 });

    // Give Angular time to fully populate data for the target date
    await new Promise(r => setTimeout(r, 5000));

    // Step 3: Extract team data from sidebar
    console.log("[scrape] Extracting team data...");
    const teams = await page.evaluate(() => {
      const sections = document.querySelectorAll("section.matchup-list");
      const results = [];

      sections.forEach((section, index) => {
        // Team name
        const nameEl = section.querySelector("h4.matchup-list__name");
        const name = nameEl ? nameEl.textContent.trim() : `Unknown Team ${index + 1}`;

        // Season score — h2 text is like "Season 771"
        const seasonEl = section.querySelector("h2.matchup-list__score-primary--title") ||
                         section.querySelector("h2:not([class*='alt'])");
        let seasonPts = 0;
        if (seasonEl) {
          const nums = seasonEl.textContent.match(/[\d.]+/g);
          if (nums && nums.length > 0) seasonPts = parseFloat(nums[nums.length - 1]) || 0;
        }

        // Day score — h2 text is like "Day 9"
        const dayEl = section.querySelector("h2.matchup-list__score-primary--alt") ||
                      section.querySelector("[class*='score-primary--alt']");
        let dayPts = 0;
        if (dayEl) {
          const nums = dayEl.textContent.match(/[\d.]+/g);
          if (nums && nums.length > 0) dayPts = parseFloat(nums[nums.length - 1]) || 0;
        }

        // Projected points
        const projEl = section.querySelector("h3.matchup-list__score-secondary");
        let projectedFpg = 0;
        if (projEl) {
          const nums = projEl.textContent.match(/[\d.]+/g);
          if (nums && nums.length > 0) projectedFpg = parseFloat(nums[nums.length - 1]) || 0;
        }

        // GP — lives in player-game-info > mark > first <i> tag
        // DOM: <player-game-info class="player-game-info matchup-list__game-info">
        //        <mark><mat-icon>people</mat-icon><i>15</i><i>0</i><i>0</i></mark>
        let gp = 0;
        const gameInfoEl = section.querySelector("player-game-info, .player-game-info, .matchup-list__game-info");
        if (gameInfoEl) {
          const iTags = gameInfoEl.querySelectorAll("i");
          if (iTags.length >= 1) gp = parseInt(iTags[0].textContent.trim()) || 0;
        }
        // Fallback: try old selectors
        if (gp === 0) {
          const rosterInfoEl = section.querySelector(".matchup-list__roster-info, .roster-info");
          if (rosterInfoEl) {
            const nums = rosterInfoEl.textContent.match(/\d+/g);
            if (nums && nums.length >= 1) gp = parseInt(nums[0], 10) || 0;
          }
        }

        results.push({
          rank: index + 1,
          name,
          seasonPts,
          dayPts,
          projectedFpg,
          gp
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

          // Try to find GP in the text — pattern "N 0 0" after scores
          let gp = 0;
          const gpMatch = text.match(/(\d+)\s+\d+\s+\d+/);
          if (gpMatch) {
            // The first "N 0 0" pattern after the scores is the roster line
            // But we need to skip score numbers — look for the last such pattern
            const allGpMatches = [...text.matchAll(/(\d+)\s+0\s+0/g)];
            if (allGpMatches.length > 0) {
              gp = parseInt(allGpMatches[allGpMatches.length - 1][1], 10) || 0;
            }
          }

          results.push({
            rank: index + 1,
            name,
            seasonPts: parsed[0] || 0,
            dayPts: parsed[1] || 0,
            projectedFpg: parsed[2] || 0,
            gp
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
