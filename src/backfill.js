// ============================================================
// HISTORICAL BACKFILL SCRAPER
// ============================================================
// Scrapes daily scoring data from past Sparky League seasons.
// Uses the same login and extraction code as the nightly pipeline.
//
// Usage:
//   node src/backfill.js 2024-25           # scrape full season
//   node src/backfill.js 2024-25 --resume  # skip dates already scraped
//   node src/backfill.js 2024-25 --from 2025-01-15
//   node src/backfill.js 2024-25 --dry-run
// ============================================================

const fs = require("fs");
const path = require("path");
const { launchAndLogin, scrapeDateFromPage } = require("./scrape");

const DATA_ROOT = path.join(__dirname, "..", "data");

// ---- Season Configuration ----
const SEASONS = {
  "2025-26": { leagueId: "264ojs1imd3nogmp", start: "2025-10-01", end: "2026-04-30" },
  "2024-25": { leagueId: "ekl6b1tfm0gt4yrp", start: "2024-10-01", end: "2025-04-30" },
  "2023-24": { leagueId: "7oc0fqtflgi4cp20", start: "2023-10-01", end: "2024-04-30" },
  "2022-23": { leagueId: "w1vrvp53l2qeip80", start: "2022-10-01", end: "2023-04-30" },
  "2021-22": { leagueId: "05x105avkrnlt69y", start: "2021-10-01", end: "2022-04-30" },
  "2020-21": { leagueId: "duoc9kyxkckntvz9", start: "2021-01-01", end: "2021-07-10" },
  "2019-20": { leagueId: "jliwhz8sju762kt6", start: "2019-10-01", end: "2020-09-22" },
  "2018-19": { leagueId: "dznx4qcfjg9jw9r1", start: "2018-10-01", end: "2019-04-30" },
  "2017-18": { leagueId: "y7lh96n0j4gis1zp", start: "2017-10-01", end: "2018-04-30" },
  "2016-17": { leagueId: "1cjco448imwflkv1", start: "2016-10-01", end: "2017-04-30" },
  "2015-16": { leagueId: "fmasu1gdicvgww63", start: "2015-10-01", end: "2016-04-30" },
  "2014-15": { leagueId: "rd5kqgdzhu52w32g", start: "2014-10-01", end: "2015-04-30" },
  "2013-14": { leagueId: "hctlmwrfhm2u46ji", start: "2013-10-01", end: "2014-04-30" },
};

/**
 * Generate all dates between start and end (inclusive), YYYY-MM-DD.
 */
function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start + "T12:00:00Z");
  const last = new Date(end + "T12:00:00Z");
  while (cur <= last) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function main() {
  const args = process.argv.slice(2);
  const seasonKey = args.find(a => !a.startsWith("--"));

  if (!seasonKey || !SEASONS[seasonKey]) {
    console.log("Usage: node src/backfill.js <season> [options]");
    console.log("\nAvailable seasons:");
    for (const key of Object.keys(SEASONS)) {
      console.log(`  ${key}`);
    }
    console.log("\nOptions:");
    console.log("  --resume       Skip dates that already have JSON files");
    console.log("  --from DATE    Start from a specific date (YYYY-MM-DD)");
    console.log("  --dry-run      List dates without scraping");
    process.exit(1);
  }

  const season = SEASONS[seasonKey];
  const resume = args.includes("--resume");
  const dryRun = args.includes("--dry-run");
  const fromIdx = args.indexOf("--from");
  const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : null;

  const username = process.env.FANTRAX_USERNAME;
  const password = process.env.FANTRAX_PASSWORD;
  if (!dryRun && (!username || !password)) {
    console.error("Set FANTRAX_USERNAME and FANTRAX_PASSWORD environment variables.");
    process.exit(1);
  }

  // Season-specific output directory (e.g. data/daily-2024-25/)
  const outputDir = path.join(DATA_ROOT, `daily-${seasonKey}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Build date list
  let dates = dateRange(season.start, season.end);
  if (fromDate) dates = dates.filter(d => d >= fromDate);
  if (resume) dates = dates.filter(d => !fs.existsSync(path.join(outputDir, `${d}.json`)));

  console.log(`[backfill] Season: ${seasonKey}`);
  console.log(`[backfill] League: ${season.leagueId}`);
  console.log(`[backfill] Output: ${outputDir}`);
  console.log(`[backfill] Dates to process: ${dates.length}`);

  if (dryRun) {
    dates.forEach(d => console.log(`  ${d}`));
    return;
  }

  if (dates.length === 0) {
    console.log("[backfill] Nothing to scrape.");
    return;
  }

  // Login once, reuse the session for all dates
  const { browser, page } = await launchAndLogin({ username, password, headless: true });

  let scraped = 0, skipped = 0, errors = 0;
  const startTime = Date.now();

  try {
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = ((i / dates.length) * 100).toFixed(1);
      process.stdout.write(`\r[backfill] ${pct}% | ${date} | scraped: ${scraped} skipped: ${skipped} errors: ${errors} | ${elapsed}s`);

      try {
        const result = await scrapeDateFromPage(page, season.leagueId, date);

        if (!result) {
          skipped++;
          continue;
        }

        const data = {
          date,
          season: seasonKey,
          period: null,  // Assigned in post-processing
          teams: result.teams.map(t => ({
            franchise: t.name,
            name: t.name,
            dayPts: t.dayPts || 0,
            projPts: t.projectedFpg || 0,
            gp: t.gp || 0,
          })),
        };

        fs.writeFileSync(
          path.join(outputDir, `${date}.json`),
          JSON.stringify(data, null, 2)
        );
        scraped++;

      } catch (e) {
        errors++;
        console.log(`\n  [${date}] Error: ${e.message}`);
        if (errors > 10) {
          console.log("\n[backfill] Too many errors — aborting. Use --resume to continue.");
          break;
        }
      }

      // Polite delay
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    await browser.close();
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n\n[backfill] Done.`);
  console.log(`  Scraped: ${scraped}`);
  console.log(`  No data: ${skipped}`);
  console.log(`  Errors:  ${errors}`);
  console.log(`  Time:    ${totalTime} min`);

  if (scraped > 0) {
    console.log(`\n[backfill] Next steps:`);
    console.log(`  1. Review raw team names:  grep -h "name" data/daily/${seasonKey.split("-")[0]}*.json | sort -u`);
    console.log(`  2. Add any missing entries to toFranchise() in config.js`);
    console.log(`  3. Assign periods to the scraped data`);
  }
}

main().catch(err => {
  console.error("[backfill] Fatal:", err.message);
  process.exit(1);
});
