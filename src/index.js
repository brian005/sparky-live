// ============================================================
// SPARKY LIVE — MAIN ORCHESTRATOR v2
// ============================================================
// Nightly pipeline:
//   Scrape → Save daily JSON → Analyze → Scoreboard → Commentary → Slack
//
// Usage:
//   node src/index.js                  # Full nightly run
//   node src/index.js --dry-run        # Scrape + analyze + scoreboard, skip Slack
//
// Required env vars:
//   FANTRAX_USERNAME, FANTRAX_PASSWORD
//
// For full run:
//   ANTHROPIC_API_KEY
//   SLACK_BOT_TOKEN + SLACK_CHANNEL_ID   (image + text)
//   or SLACK_WEBHOOK_URL                 (text-only fallback)
//
// Optional:
//   HEADLESS=false     Debug with visible browser
//   TARGET_DATE        Override date (YYYY-MM-DD) for scraping
// ============================================================

const { scrapeLiveScoring } = require("./scrape");
const { buildNightlyAnalysis, saveDailyScore } = require("./analyze");
const { generateCardStrips, generateScoreboard } = require("./scoreboard");
const { generateCommentary } = require("./commentary");
const { postUpdate, postCardStrips } = require("./slack");
const { getCurrentPeriod, getPeriodForDate, buildDateScoringUrl, buildPeriodScoringUrl, toFranchise, FRANCHISE_NAMES } = require("./config");
const path = require("path");

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const config = {
    username: process.env.FANTRAX_USERNAME,
    password: process.env.FANTRAX_PASSWORD,
    apiKey: process.env.ANTHROPIC_API_KEY,
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    botToken: process.env.SLACK_BOT_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
    headless: process.env.HEADLESS !== "false",
    targetDate: process.env.TARGET_DATE || null,
  };

  if (!config.username || !config.password) {
    console.error("❌ FANTRAX_USERNAME and FANTRAX_PASSWORD are required.");
    process.exit(1);
  }

  // Auto-detect date and period.
  // The cron targets ~10:30 PM PT but GitHub Actions can delay 30+ min,
  // sometimes pushing past midnight. If running between midnight and 6 AM PT,
  // the games we want belong to yesterday — roll the date back.
  let today;
  if (config.targetDate) {
    today = config.targetDate;
  } else {
    const nowPT = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const ptDate = new Date(nowPT);
    const ptHour = ptDate.getHours();

    if (ptHour < 6) {
      // Past midnight — roll back to yesterday (the actual game night)
      ptDate.setDate(ptDate.getDate() - 1);
      console.log(`⏰ Late cron detected (${ptHour}:xx AM PT) — using yesterday's date.`);
    }

    today = ptDate.toLocaleDateString("en-CA");
  }
  const period = getPeriodForDate(today);

  if (!period) {
    console.log(`⏸️  ${today} is not within any scoring period (Olympic break or off-season). Exiting.`);
    process.exit(0);
  }

  // if (!dryRun && !config.apiKey) {
  //   console.error("❌ ANTHROPIC_API_KEY is required for live runs.");
  //   process.exit(1);
  // }
  if (!dryRun && !config.webhookUrl && !config.botToken) {
    console.error("❌ SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN required for live runs.");
    process.exit(1);
  }

  console.log(`\n🏒 SPARKY LIVE — Nightly Pipeline`);
  console.log(`   Date:   ${today}`);
  console.log(`   Period: ${period}`);
  console.log(`   Mode:   ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  try {
    // Step 1: Scrape today's scores
    console.log("━━━ STEP 1: SCRAPING FANTRAX ━━━");
    const scrapeData = await scrapeLiveScoring({
      username: config.username,
      password: config.password,
      period,
      date: today,
      headless: config.headless
    });

    console.log(`  Found ${scrapeData.teams.length} teams`);
    scrapeData.teams.forEach(t => {
      const gpInfo = t.periodTotalGP ? ` | periodGP=${t.periodGP}+${t.periodGPRemaining}=${t.periodTotalGP}` : "";
      console.log(`    ${t.rank}. ${t.name}: day=${t.dayPts}, proj=${t.projectedFpg}${gpInfo}`);
    });

    // Step 2: Save daily JSON
    console.log("\n━━━ STEP 2: SAVING DAILY SCORE ━━━");
    const dailyData = saveDailyScore(scrapeData, today);

    // Step 3: Build analysis from full history
    console.log("\n━━━ STEP 3: ANALYZING ━━━");
    const analysis = await buildNightlyAnalysis(dailyData);

    console.log(`  Season days loaded: ${analysis.totalSeasonDays}`);
    console.log(`  Period ${period} days: ${analysis.periodDaysPlayed}`);
    console.log("\n  Day rankings:");
    analysis.teams.forEach(t => {
      console.log(`    ${t.dayRank}. ${t.franchise}: ${t.dayPts} day | ${t.seasonPts} season | 3d=${t.avg3d} 7d=${t.avg7d}`);
    });

    // Check if any games were played today
    const totalGP = analysis.teams.reduce((sum, t) => sum + (t.gp || 0), 0);
    if (totalGP === 0) {
      console.log("\n⏸️  No games played today (0 GP across all teams). Skipping.");
      process.exit(0);
    }

    // Step 4: Generate card strip images
    console.log("\n━━━ STEP 4: GENERATING CARD STRIPS ━━━");
    const cardsDir = path.join(__dirname, "..", "cards");
    let cardPaths = [];
    try {
      cardPaths = await generateCardStrips(analysis, { outputDir: cardsDir });
    } catch (err) {
      console.log(`  ⚠️ Card generation failed (${err.message}) — continuing without images.`);
    }

    if (dryRun) {
      console.log("\n━━━ DRY RUN — Skipping commentary and Slack ━━━");
      if (cardPaths.length > 0) {
        console.log(`\n${cardPaths.length} card strips saved to: ${cardsDir}`);
      }
      console.log("\nAnalysis context:");
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }

    // Step 5: Commentary (disabled for now — focusing on card quality)
    // const commentary = await generateCommentary(analysis, config.apiKey, "nightly");

    // Step 6: Post to Slack
    console.log("━━━ STEP 6: POSTING TO SLACK ━━━");

    const dateDisplay = new Date(today + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const headerText = `🏒 *P${period}: ${dateDisplay} — Nightly Recap*`;

    if (config.botToken && config.channelId && cardPaths.length > 0) {
      await postCardStrips({
        botToken: config.botToken,
        channelId: config.channelId,
        headerText,
        cardPaths,
      });
    } else {
      // Fallback: combined image or text-only
      let scoreboardPath = null;
      try {
        scoreboardPath = path.join(__dirname, "..", "scoreboard.png");
        await generateScoreboard(analysis, { outputPath: scoreboardPath });
      } catch (err) {
        console.log(`  ⚠️ Combined scoreboard failed — posting text only.`);
        scoreboardPath = null;
      }
      await postUpdate({
        webhookUrl: config.webhookUrl,
        botToken: config.botToken,
        channelId: config.channelId,
        commentary,
        scoreboardPath,
      });
    }

    console.log("\n✅ Nightly pipeline complete!");

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();
