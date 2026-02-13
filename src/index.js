// ============================================================
// SPARKY LIVE — MAIN ORCHESTRATOR
// ============================================================
// Usage:
//   node src/index.js                  # Full run: scrape → analyze → comment → post
//   node src/index.js --dry-run        # Scrape + analyze only, print to console
//
// Required env vars:
//   FANTRAX_USERNAME    - Fantrax login email
//   FANTRAX_PASSWORD    - Fantrax login password
//   ANTHROPIC_API_KEY   - Claude API key
//   SLACK_WEBHOOK_URL   - Slack incoming webhook URL
//   CURRENT_PERIOD      - Current scoring period number
//
// Optional:
//   COMMENTARY_TYPE     - "update" (default) or "nightly"
//   HEADLESS            - "true" (default) or "false" for debugging
// ============================================================

const { scrapeLiveScoring } = require("./scrape");
const { buildContext, saveSnapshot } = require("./analyze");
const { generateCommentary } = require("./commentary");
const { postToSlack } = require("./slack");

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Load config from environment
  const config = {
    username: process.env.FANTRAX_USERNAME,
    password: process.env.FANTRAX_PASSWORD,
    apiKey: process.env.ANTHROPIC_API_KEY,
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    period: parseInt(process.env.CURRENT_PERIOD),
    commentaryType: process.env.COMMENTARY_TYPE || "update",
    headless: process.env.HEADLESS !== "false"
  };

  // Validate
  if (!config.username || !config.password) {
    console.error("❌ FANTRAX_USERNAME and FANTRAX_PASSWORD are required.");
    process.exit(1);
  }
  if (!config.period || isNaN(config.period)) {
    console.error("❌ CURRENT_PERIOD is required (number).");
    process.exit(1);
  }
  if (!dryRun && !config.apiKey) {
    console.error("❌ ANTHROPIC_API_KEY is required for live runs.");
    process.exit(1);
  }
  if (!dryRun && !config.webhookUrl) {
    console.error("❌ SLACK_WEBHOOK_URL is required for live runs.");
    process.exit(1);
  }

  try {
    // Step 1: Scrape
    console.log("━━━ STEP 1: SCRAPING FANTRAX ━━━");
    const scrapeData = await scrapeLiveScoring({
      username: config.username,
      password: config.password,
      period: config.period,
      headless: config.headless
    });

    console.log(`  Found ${scrapeData.teams.length} teams`);
    scrapeData.teams.forEach(t => {
      console.log(`    ${t.rank}. ${t.name}: ${t.seasonPts} (day: ${t.dayPts})`);
    });

    // Step 2: Save snapshot
    console.log("\n━━━ STEP 2: SAVING SNAPSHOT ━━━");
    saveSnapshot(scrapeData);

    // Step 3: Build context
    console.log("\n━━━ STEP 3: BUILDING CONTEXT ━━━");
    const context = buildContext(scrapeData);

    if (context.changes) {
      console.log(`  Changes since last scrape (${context.changes.timeSinceLast} ago):`);
      context.changes.movements.forEach(m => {
        console.log(`    ${m.franchise}: ${m.ptsDiff >= 0 ? "+" : ""}${m.ptsDiff} pts (rank ${m.prevRank} → ${m.currentRank})`);
      });
    } else {
      console.log("  No previous snapshot — first scrape of this period.");
    }

    if (dryRun) {
      console.log("\n━━━ DRY RUN — Skipping commentary and Slack ━━━");
      console.log("\nContext that would be sent to Claude:");
      console.log(JSON.stringify(context, null, 2));
      return;
    }

    // Step 4: Generate commentary
    console.log("\n━━━ STEP 4: GENERATING COMMENTARY ━━━");
    const commentary = await generateCommentary(context, config.apiKey, config.commentaryType);
    console.log("\n--- Commentary ---");
    console.log(commentary);
    console.log("--- End ---\n");

    // Step 5: Post to Slack
    console.log("━━━ STEP 5: POSTING TO SLACK ━━━");
    await postToSlack(config.webhookUrl, commentary);

    console.log("\n✅ Complete!");

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();
