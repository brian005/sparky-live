// ============================================================
// SCORIGAMI — Morning Post
// ============================================================
// Checks last night's daily scores against 13 years of history.
// A "scorigami" is a (dayPts, GP) combo that has never occurred.
// Posts to #chat via SparkyBot if any are found; silent if none.
//
// Designed to run as a morning GitHub Action (e.g. 8 AM PT)
// reading committed daily JSONs — no scraping needed.
// ============================================================

const fs = require("fs");
const path = require("path");
const { toFranchise, FRANCHISE_NAMES } = require("./config");

const DATA_ROOT = path.join(__dirname, "..", "data");

/**
 * Find all daily score directories (data/daily, data/daily-2024-25, etc.)
 */
function findDailyDirs() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs.readdirSync(DATA_ROOT)
    .filter(d => d.startsWith("daily") && fs.statSync(path.join(DATA_ROOT, d)).isDirectory())
    .map(d => path.join(DATA_ROOT, d));
}

/**
 * Load all daily score files from ALL daily directories and build the historical grid.
 * Returns a Set of "pts|gp" keys representing every combo that has occurred.
 */
function buildHistoricalGrid(excludeDate) {
  const grid = new Set();
  const dirs = findDailyDirs();

  for (const dir of dirs) {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".json") && f !== ".gitkeep")
      .sort();

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        if (!data.teams || data.teams.length === 0) continue;

        // Skip the date we're checking (so it's truly "before last night")
        if (data.date === excludeDate) continue;

        // Skip days where every team scored 0
        const totalPts = data.teams.reduce((sum, t) => sum + (t.dayPts || 0), 0);
        if (totalPts === 0) continue;

        for (const t of data.teams) {
          const pts = Math.round(t.dayPts || 0);
          const gp = t.gp || 0;
          if (gp > 0) {
            grid.add(`${pts}|${gp}`);
          }
        }
      } catch (e) {
        // Skip corrupt files
      }
    }
  }

  return grid;
}

/**
 * Check last night's scores against the historical grid.
 * Returns array of scorigami entries: { franchise, name, pts, gp }
 */
function checkScorigami(date) {
  // Find the file for this date across all daily directories
  let filepath = null;
  for (const dir of findDailyDirs()) {
    const candidate = path.join(dir, `${date}.json`);
    if (fs.existsSync(candidate)) {
      filepath = candidate;
      break;
    }
  }

  if (!filepath) {
    console.log(`[scorigami] No data file for ${date}`);
    return [];
  }

  const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  if (!data.teams || data.teams.length === 0) return [];

  const grid = buildHistoricalGrid(date);
  const dirCount = findDailyDirs().length;
  console.log(`[scorigami] Scanned ${dirCount} daily dirs — ${grid.size} unique (pts, GP) combos`);

  const results = [];

  for (const t of data.teams) {
    const pts = Math.round(t.dayPts || 0);
    const gp = t.gp || 0;
    if (gp <= 0) continue;

    const key = `${pts}|${gp}`;
    if (!grid.has(key)) {
      const franchise = toFranchise(t.franchise) || toFranchise(t.name) || t.franchise;
      results.push({
        franchise,
        name: FRANCHISE_NAMES[franchise] || t.name || franchise,
        pts,
        gp,
      });
    }
  }

  return results;
}

/**
 * Format the Slack message for scorigami results.
 */
function formatSlackMessage(date, scorigamis) {
  if (scorigamis.length === 0) return null;

  const dateLabel = new Date(date + "T12:00:00Z")
    .toLocaleDateString("en-US", { month: "long", day: "numeric" });

  const lines = scorigamis.map(s =>
    `${s.name} (${s.franchise}): ${s.pts} pts on ${s.gp} GP`
  );

  const header = scorigamis.length === 1
    ? `SCORIGAMI — ${dateLabel}`
    : `${scorigamis.length} SCORIGAMIS — ${dateLabel}`;

  return `${header}\n${lines.join("\n")}\n\nA pts/GP combo that has never occurred in league history.`;
}

/**
 * Main: check last night and post if any scorigamis found.
 */
async function main() {
  // Determine which date to check
  // If run in the morning, check yesterday's date
  const dateArg = process.argv[2];
  let checkDate;

  if (dateArg) {
    checkDate = dateArg;
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    checkDate = yesterday.toISOString().split("T")[0];
  }

  console.log(`[scorigami] Checking ${checkDate}...`);

  const scorigamis = checkScorigami(checkDate);

  if (scorigamis.length === 0) {
    console.log(`[scorigami] No scorigamis last night. Skipping post.`);
    return;
  }

  console.log(`[scorigami] Found ${scorigamis.length} scorigami(s)!`);
  scorigamis.forEach(s => console.log(`  ${s.franchise}: ${s.pts} pts / ${s.gp} GP`));

  const message = formatSlackMessage(checkDate, scorigamis);
  console.log(`\n${message}`);

  // Post to Slack if configured
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (botToken && channelId) {
    const { postToSlack } = require("./slack");
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;

    if (webhookUrl) {
      await postToSlack(webhookUrl, message, {
        username: "SparkyBot",
        icon_emoji: ":game_die:",
      });
      console.log("[scorigami] Posted to Slack.");
    } else {
      // Use bot token API for chat.postMessage
      const https = require("https");
      const data = JSON.stringify({
        channel: channelId,
        text: message,
      });

      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "slack.com",
          path: "/api/chat.postMessage",
          method: "POST",
          headers: {
            "Authorization": `Bearer ${botToken}`,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(data),
          },
        }, (res) => {
          let body = "";
          res.on("data", chunk => body += chunk);
          res.on("end", () => {
            const parsed = JSON.parse(body);
            if (parsed.ok) resolve();
            else reject(new Error(`Slack error: ${parsed.error}`));
          });
        });
        req.on("error", reject);
        req.write(data);
        req.end();
      });

      console.log("[scorigami] Posted to Slack via bot token.");
    }
  } else {
    console.log("[scorigami] No Slack credentials — message printed above only.");
  }
}

main().catch(err => {
  console.error("[scorigami] Error:", err.message);
  process.exit(1);
});

module.exports = { buildHistoricalGrid, checkScorigami, formatSlackMessage };
