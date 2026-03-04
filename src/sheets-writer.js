/**
 * ═══════════════════════════════════════════════════════════════
 * SPARKY SHEETS WRITER
 * ═══════════════════════════════════════════════════════════════
 *
 * Writes daily scoring data from the nightly Fantrax scrape
 * to the "Daily Scoring" tab on SPARKY | Records and Performance 2026.
 *
 * One row per night, 20 columns:
 *   Date | Period | JGC Pts | JGC Proj | JGC GP | PWN Pts | PWN Proj | PWN GP | ... | GDD GP
 *
 * SETUP:
 *   1. npm install googleapis
 *   2. Set GOOGLE_SERVICE_ACCOUNT_KEY as a GitHub secret
 *   3. Share the spreadsheet with the service account email (Editor access)
 *   4. Add writeDailyScoring() call to your nightly GitHub Action
 *
 * USAGE:
 *   const { writeDailyScoring, backfillDailyScoring } = require('./sheets-writer');
 *
 *   const data = JSON.parse(fs.readFileSync('data/daily/2026-03-03.json'));
 *   await writeDailyScoring(data);
 *
 *   // One-time backfill:
 *   await backfillDailyScoring('./data/daily');
 * ═══════════════════════════════════════════════════════════════
 */

const { google } = require("googleapis");

// ── CONFIG ──────────────────────────────────────────────────────

const SPREADSHEET_ID = "1MbusvKdOqOp-TOHIjAW0rQxj_0Z33v1lQFLcnKqaD9Q";
const DAILY_SCORING_TAB = "Daily Scoring";
const DASHBOARD_TAB = "Dashboard";

// Each franchise gets 3 columns: Pts | Proj | GP
const FRANCHISE_ORDER = ["JGC", "PWN", "BEW", "MPP", "RMS", "GDD"];

/**
 * Returns the header row for the Daily Scoring tab.
 * Call once when setting up the tab.
 *
 * ["Date", "Period", "JGC Pts", "JGC Proj", "JGC GP", "PWN Pts", ...]
 */
function buildHeaderRow() {
  const headers = ["Date", "Period"];
  for (const code of FRANCHISE_ORDER) {
    headers.push(`${code} Pts`, `${code} Proj`, `${code} GP`);
  }
  return headers;
}

// ── AUTH ─────────────────────────────────────────────────────────

async function getAuthClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY environment variable not set.");
  }
  const key = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
}

async function getSheetsClient() {
  const authClient = await getAuthClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// ── DAILY SCORING WRITE ─────────────────────────────────────────

/**
 * Writes one row of daily scoring to the "Daily Scoring" tab.
 *
 * @param {Object} dailyData - Parsed daily JSON
 *   { date, period, teams: [{ franchise, dayPts, projPts, gp, ... }] }
 */
async function writeDailyScoring(dailyData) {
  const sheets = await getSheetsClient();
  const { date, period, teams } = dailyData;

  if (!teams || teams.length === 0) {
    throw new Error("No team data in daily JSON for " + date);
  }

  // Check for duplicates
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DAILY_SCORING_TAB}'!A:A`,
  });
  const existingDates = (existing.data.values || []).flat();
  if (existingDates.includes(date)) {
    console.log(`[sheets-writer] ${date} already exists. Skipping.`);
    return { success: true, rowsWritten: 0, date, skipped: true };
  }

  // Build lookup: franchise code → team object
  const teamByFranchise = {};
  for (const team of teams) {
    teamByFranchise[team.franchise] = team;
  }

  // Build one wide row: Date | Period | JGC Pts | JGC Proj | JGC GP | ...
  const row = [date, period];
  for (const code of FRANCHISE_ORDER) {
    const t = teamByFranchise[code];
    row.push(t ? t.dayPts : 0, t ? t.projPts : 0, t ? t.gp : 0);
  }

  // Append
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DAILY_SCORING_TAB}'!A:T`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  const summary = FRANCHISE_ORDER.map(
    (c) => c + "=" + (teamByFranchise[c]?.dayPts ?? 0)
  ).join(", ");
  console.log(`[sheets-writer] Wrote ${date} (Period ${period}): ${summary}`);

  await logToDashboard(
    "Daily Scoring Write",
    "OK",
    `${date} (Period ${period}): ${summary}`
  );

  return { success: true, rowsWritten: 1, date };
}

// ── BACKFILL ────────────────────────────────────────────────────

/**
 * Backfills daily scoring from a directory of JSON files.
 * Skips dates that already exist in the sheet.
 *
 * @param {string} dataDir - Path to data/daily/ directory
 */
async function backfillDailyScoring(dataDir) {
  const fs = require("fs");
  const path = require("path");

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`[sheets-writer] Backfilling ${files.length} files from ${dataDir}`);

  let written = 0;
  let skipped = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));

    try {
      const result = await writeDailyScoring(data);
      if (result.skipped) {
        skipped++;
      } else {
        written++;
      }
    } catch (err) {
      console.error(`[sheets-writer] Error on ${file}: ${err.message}`);
    }

    // Rate limit buffer
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `[sheets-writer] Backfill done: ${written} written, ${skipped} skipped, ${files.length} total.`
  );

  return { filesProcessed: files.length, rowsWritten: written, skipped };
}

// ── WRITE HEADER ────────────────────────────────────────────────

/**
 * Writes the header row to the Daily Scoring tab.
 * Run once during initial setup.
 */
async function writeHeader() {
  const sheets = await getSheetsClient();
  const headers = buildHeaderRow();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DAILY_SCORING_TAB}'!A1:T1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers] },
  });

  console.log(`[sheets-writer] Header row written: ${headers.join(" | ")}`);
}

// ── DASHBOARD LOGGING ───────────────────────────────────────────

/**
 * Appends a log row to the Dashboard tab.
 * Columns: Timestamp | System | Result | Details
 */
async function logToDashboard(system, result, details) {
  try {
    const sheets = await getSheetsClient();
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${DASHBOARD_TAB}'!A:D`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[timestamp, system, result, details]],
      },
    });
  } catch (err) {
    console.error(`[sheets-writer] Dashboard log failed: ${err.message}`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────

/**
 * Command line usage:
 *   node sheets-writer.js write data/daily/2026-03-03.json
 *   node sheets-writer.js backfill data/daily/
 *   node sheets-writer.js header
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "header") {
    await writeHeader();
    return;
  }

  const target = args[1];
  if (!command || !target) {
    console.log("Usage:");
    console.log("  node sheets-writer.js write <json-file>");
    console.log("  node sheets-writer.js backfill <data-dir>");
    console.log("  node sheets-writer.js header");
    process.exit(1);
  }

  const fs = require("fs");

  if (command === "write") {
    const data = JSON.parse(fs.readFileSync(target, "utf8"));
    const result = await writeDailyScoring(data);
    console.log(result);
  } else if (command === "backfill") {
    const result = await backfillDailyScoring(target);
    console.log(result);
  } else {
    console.error("Unknown command: " + command);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  writeDailyScoring,
  backfillDailyScoring,
  writeHeader,
  buildHeaderRow,
  logToDashboard,
};
