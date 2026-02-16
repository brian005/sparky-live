// ============================================================
// SPARKY LIVE — MAIN ORCHESTRATOR
// ============================================================
// Usage:
//   node src/index.js                  # Full run: scrape → analyze → scoreboard → comment → post
//   node src/index.js --dry-run        # Scrape + analyze + scoreboard, print to console
//
// Required env vars:
//   FANTRAX_USERNAME    - Fantrax login email
//   FANTRAX_PASSWORD    - Fantrax login password
//   ANTHROPIC_API_KEY   - Claude API key
//   CURRENT_PERIOD      - Current scoring period number
//
// For posting (one of these combos):
//   SLACK_WEBHOOK_URL                  - Text-only posting via webhook
//   SLACK_BOT_TOKEN + SLACK_CHANNEL_ID - Image + text posting via Bot API
//
// Optional:
//   COMMENTARY_TYPE     - "update" (default) or "nightly"
//   HEADLESS            - "true" (default) or "false" for debugging
// ============================================================

const { scrapeLiveScoring } = require("./scrape");
const { buildContext, saveSnapshot } = require("./analyze");
const { generateScoreboard } = require("./scoreboard");
const { generateCommentary } = require("./commentary");
const { postUpdate } = require("./slack");
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
    period: parseInt(process.env.CURRENT_PERIOD),
    commentaryType: process.env.COMMENTARY_TYPE || "update",
    headless: process.env.HEADLESS !== "false"
  };

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
  if (!dryRun && !config.webhookUrl && !config.botToken) {
    console.error("❌ SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN is required for live runs.");
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

    // Step 4: Generate scoreboard image
    console.log("\n━━━ STEP 4: GENERATING SCOREBOARD ━━━");
    const scoreboardPath = path.join(__dirname, "..", "scoreboard.png");
    let scoreboardGenerated = false;
    try {
      await generateScoreboard(context, { outputPath: scoreboardPath });
      console.log("  Scoreboard image generated.");
      scoreboardGenerated = true;
    } catch (err) {
      console.log(`  ⚠️ Scoreboard generation failed (${err.message}) — continuing without image.`);
    }

    if (dryRun) {
      console.log("\n━━━ DRY RUN — Skipping commentary and Slack ━━━");
      console.log("\nContext that would be sent to Claude:");
      console.log(JSON.stringify(context, null, 2));
      if (scoreboardGenerated) {
        console.log(`\nScoreboard image saved to: ${scoreboardPath}`);
      }
      return;
    }

    // Step 5: Generate commentary
    console.log("\n━━━ STEP 5: GENERATING COMMENTARY ━━━");
    const commentary = await generateCommentary(context, config.apiKey, config.commentaryType);
    console.log("\n--- Commentary ---");
    console.log(commentary);
    console.log("--- End ---\n");

    // Step 6: Post to Slack
    console.log("━━━ STEP 6: POSTING TO SLACK ━━━");
    await postUpdate({
      webhookUrl: config.webhookUrl,
      botToken: config.botToken,
      channelId: config.channelId,
      commentary,
      scoreboardPath: scoreboardGenerated ? scoreboardPath : null
    });

    console.log("\n✅ Complete!");

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();
