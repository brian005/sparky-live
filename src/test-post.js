// ============================================================
// TEST POST — Load historical daily data and post to Slack
// ============================================================
// Skips Fantrax scrape entirely. Loads an existing daily JSON
// from data/daily/, runs analysis, generates card strips,
// generates commentary, and posts to Slack.
//
// Usage:
//   node src/test-post.js 2026-01-25           # Post for Jan 25
//   node src/test-post.js 2026-01-25 --dry-run # Generate cards only, no Slack
//
// Required env vars (for live post):
//   ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
// ============================================================

const fs = require("fs");
const path = require("path");
const { buildNightlyAnalysis } = require("./analyze");
const { generateCardStrips, generateScoreboard } = require("./scoreboard");
const { postCardStrips } = require("./slack");
const { getPeriodForDate } = require("./config");

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const targetDate = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

  if (!targetDate) {
    console.error("Usage: node src/test-post.js YYYY-MM-DD [--dry-run]");
    process.exit(1);
  }

  const period = getPeriodForDate(targetDate);
  if (!period) {
    console.error(`❌ ${targetDate} is not within any scoring period.`);
    process.exit(1);
  }

  // Load the daily JSON
  const dailyPath = path.join(__dirname, "..", "data", "daily", `${targetDate}.json`);
  if (!fs.existsSync(dailyPath)) {
    console.error(`❌ No daily data found: ${dailyPath}`);
    console.error("   Run the backfill first or pick a date that has data.");
    process.exit(1);
  }

  const dailyData = JSON.parse(fs.readFileSync(dailyPath, "utf-8"));
  console.log(`\n🏒 TEST POST — ${targetDate} (Period ${period})`);
  console.log(`   Mode: ${dryRun ? "DRY RUN" : "LIVE POST"}`);
  console.log(`   Teams: ${dailyData.teams.length}`);

  // Check for actual points
  const totalPts = dailyData.teams.reduce((sum, t) => sum + (t.dayPts || 0), 0);
  if (totalPts === 0) {
    console.error(`❌ No points scored on ${targetDate} — nothing to post.`);
    process.exit(1);
  }
  console.log(`   Total day pts: ${totalPts}\n`);

  // Run analysis
  console.log("━━━ ANALYZING ━━━");
  const analysis = buildNightlyAnalysis(dailyData);
  console.log(`  Season days loaded: ${analysis.totalSeasonDays}`);
  console.log(`  Period ${period} days: ${analysis.periodDaysPlayed}`);
  console.log("\n  Day rankings:");
  analysis.teams.forEach(t => {
    console.log(`    ${t.dayRank}. ${t.franchise}: ${t.dayPts} day | ${t.seasonPts} season | streaks: ${t.streaks.join(", ") || "(none)"}`);
  });

  // Generate card strips
  console.log("\n━━━ GENERATING CARDS ━━━");
  const cardsDir = path.join(__dirname, "..", "cards");
  const cardPaths = await generateCardStrips(analysis, { outputDir: cardsDir });
  console.log(`  ${cardPaths.length} cards generated.`);

  // Also generate combined for reference
  const scoreboardPath = path.join(__dirname, "..", "scoreboard.png");
  await generateScoreboard(analysis, { outputPath: scoreboardPath });

  if (dryRun) {
    console.log("\n━━━ DRY RUN — Skipping Slack ━━━");
    console.log(`Cards: ${cardsDir}`);
    console.log(`Combined: ${scoreboardPath}`);
    console.log("\nAnalysis:");
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  // Check env vars
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!botToken) { console.error("❌ SLACK_BOT_TOKEN required"); process.exit(1); }
  if (!channelId) { console.error("❌ SLACK_CHANNEL_ID required"); process.exit(1); }

  // Post to Slack
  console.log("━━━ POSTING TO SLACK ━━━");
  const dateDisplay = new Date(targetDate + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const headerText = `🏒 *P${period}: ${dateDisplay} — Nightly Recap*`;

  await postCardStrips({
    botToken,
    channelId,
    headerText,
    cardPaths,
  });

  console.log("\n✅ Test post complete!");
}

main().catch(err => {
  console.error(`\n❌ ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
