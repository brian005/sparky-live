/**
 * ═══════════════════════════════════════════════════════════════
 * SPARKY SHEETS WRITER
 * ═══════════════════════════════════════════════════════════════
 *
 * Daily Scoring tab (one row per night, 20 columns):
 *   A=Date | B=Period | C=JGC Pts | D=JGC Proj | E=JGC GP |
 *   F=PWN Pts | G=PWN Proj | H=PWN GP | I=BEW Pts | J=BEW Proj |
 *   K=BEW GP | L=MPP Pts | M=MPP Proj | N=MPP GP | O=RMS Pts |
 *   P=RMS Proj | Q=RMS GP | R=GDD Pts | S=GDD Proj | T=GDD GP
 *
 * COMMANDS:
 *   node sheets-writer.js write <json-file>
 *   node sheets-writer.js backfill <data-dir>
 *   node sheets-writer.js header
 *   node sheets-writer.js setup-database
 * ═══════════════════════════════════════════════════════════════
 */

const { google } = require("googleapis");

// ── CONFIG ──────────────────────────────────────────────────────

const SPREADSHEET_ID = "1MbusvKdOqOp-TOHIjAW0rQxj_0Z33v1lQFLcnKqaD9Q";
const DAILY_SCORING_TAB = "Daily Scoring";
const DATABASE_TAB = "Database";
const DASHBOARD_TAB = "Dashboard";

const FRANCHISE_ORDER = ["JGC", "PWN", "BEW", "MPP", "RMS", "GDD"];

const SEASON = 2026;

const OWNERS = [
  { owner: "Jason",  dsPtsCol: "C", dsGpCol: "E" },
  { owner: "Brian",  dsPtsCol: "I", dsGpCol: "K" },
  { owner: "Graeme", dsPtsCol: "R", dsGpCol: "T" },
  { owner: "Chris",  dsPtsCol: "F", dsGpCol: "H" },
  { owner: "Richie", dsPtsCol: "O", dsGpCol: "Q" },
  { owner: "Matt",   dsPtsCol: "L", dsGpCol: "N" },
];

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

// ── HELPERS ─────────────────────────────────────────────────────

function buildHeaderRow() {
  const headers = ["Date", "Period"];
  for (const code of FRANCHISE_ORDER) {
    headers.push(`${code} Pts`, `${code} Proj`, `${code} GP`);
  }
  return headers;
}

function buildRowFromJson(dailyData) {
  const { date, period, teams } = dailyData;
  const teamByFranchise = {};
  for (const team of teams) {
    teamByFranchise[team.franchise] = team;
  }
  const row = [date, period];
  for (const code of FRANCHISE_ORDER) {
    const t = teamByFranchise[code];
    row.push(t ? t.dayPts : 0, t ? t.projPts : 0, t ? t.gp : 0);
  }
  return row;
}

// ── WRITE HEADER ────────────────────────────────────────────────

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

// ── DAILY SCORING WRITE (single file) ───────────────────────────

async function writeDailyScoring(dailyData) {
  const sheets = await getSheetsClient();
  const { date, period, teams } = dailyData;

  if (!teams || teams.length === 0) {
    throw new Error("No team data in daily JSON for " + date);
  }

  // Duplicate check
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DAILY_SCORING_TAB}'!A:A`,
  });
  const existingDates = (existing.data.values || []).flat();
  if (existingDates.includes(date)) {
    console.log(`[sheets-writer] ${date} already exists. Skipping.`);
    return { success: true, rowsWritten: 0, date, skipped: true };
  }

  const row = buildRowFromJson(dailyData);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DAILY_SCORING_TAB}'!A:T`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  const teamByFranchise = {};
  for (const team of teams) teamByFranchise[team.franchise] = team;
  const summary = FRANCHISE_ORDER.map(
    (c) => c + "=" + (teamByFranchise[c]?.dayPts ?? 0)
  ).join(", ");
  console.log(`[sheets-writer] Wrote ${date} (Period ${period}): ${summary}`);

  await logToDashboard("Daily Scoring Write", "OK",
    `${date} (Period ${period}): ${summary}`);

  return { success: true, rowsWritten: 1, date };
}

// ── BACKFILL (batch) ────────────────────────────────────────────

/**
 * Batch backfill: reads all existing dates in ONE call, builds all
 * missing rows in memory, writes them in ONE call. 2 API calls total.
 */
async function backfillDailyScoring(dataDir) {
  const fs = require("fs");
  const path = require("path");
  const sheets = await getSheetsClient();

  // 1. Read all existing dates in one call
  console.log("[sheets-writer] Reading existing dates...");
  let existingDates = new Set();
  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${DAILY_SCORING_TAB}'!A:A`,
    });
    existingDates = new Set((existing.data.values || []).flat());
  } catch (err) {
    console.log("[sheets-writer] No existing data found, writing all.");
  }

  // 2. Read all JSON files and build rows for missing dates
  const files = fs.readdirSync(dataDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`[sheets-writer] Found ${files.length} JSON files. Checking for missing dates...`);

  const newRows = [];
  let skipped = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    if (existingDates.has(data.date)) {
      skipped++;
      continue;
    }
    if (!data.teams || data.teams.length === 0) {
      console.error(`[sheets-writer] Skipping ${file}: no team data.`);
      continue;
    }
    newRows.push(buildRowFromJson(data));
  }

  if (newRows.length === 0) {
    console.log(`[sheets-writer] All ${files.length} files already in sheet. Nothing to write.`);
    return { filesProcessed: files.length, rowsWritten: 0, skipped };
  }

  // 3. Write all new rows in one batch call
  console.log(`[sheets-writer] Writing ${newRows.length} rows in one batch...`);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DAILY_SCORING_TAB}'!A:T`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: newRows },
  });

  console.log(`[sheets-writer] Backfill done: ${newRows.length} written, ${skipped} skipped, ${files.length} total.`);
  return { filesProcessed: files.length, rowsWritten: newRows.length, skipped };
}

// ── DATABASE SETUP ──────────────────────────────────────────────

async function setupDatabase() {
  const sheets = await getSheetsClient();
  const ds = `'${DAILY_SCORING_TAB}'`;

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });
  const dbSheet = spreadsheet.data.sheets.find(
    (s) => s.properties.title === DATABASE_TAB
  );
  if (!dbSheet) {
    throw new Error(`Tab "${DATABASE_TAB}" not found.`);
  }
  const sheetId = dbSheet.properties.sheetId;

  console.log("[sheets-writer] Inserting 4 rows for periods 10-13...");
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: 1,
              endIndex: 5,
            },
            inheritFromBefore: false,
          },
        },
      ],
    },
  });

  console.log("[sheets-writer] Writing formulas for periods 10-13...");
  const rows = [];
  const periods = [13, 12, 11, 10];

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    const r = 2 + i;
    const row = [SEASON, period];

    for (const owner of OWNERS) {
      const fptsFormula = `=SUMIFS(${ds}!${owner.dsPtsCol}:${owner.dsPtsCol},${ds}!B:B,B${r})`;
      const gpFormula = `=SUMIFS(${ds}!${owner.dsGpCol}:${owner.dsGpCol},${ds}!B:B,B${r})`;

      const ownerIdx = OWNERS.indexOf(owner);
      const dbFptsCol = String.fromCharCode(67 + ownerIdx * 4);
      const dbGpCol = String.fromCharCode(67 + ownerIdx * 4 + 2);
      const fpgFormula = `=IF(${dbGpCol}${r}>0,ROUND(${dbFptsCol}${r}/${dbGpCol}${r},2),0)`;

      row.push(fptsFormula, fpgFormula, gpFormula, "");
    }

    rows.push(row);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DATABASE_TAB}'!A2:Z5`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  console.log("[sheets-writer] Done. Periods 10-13 in rows 2-5 with auto-calculating formulas.");
  console.log("[sheets-writer] Periods 1-9 untouched.");
}

// ── DASHBOARD LOGGING ───────────────────────────────────────────

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
    // Silent fail — don't break main flow
  }
}

// ── CLI ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "header") {
    await writeHeader();
    return;
  }

  if (command === "setup-database") {
    await setupDatabase();
    return;
  }

  const target = args[1];
  if (!command || !target) {
    console.log("Usage:");
    console.log("  node sheets-writer.js write <json-file>");
    console.log("  node sheets-writer.js backfill <data-dir>");
    console.log("  node sheets-writer.js header");
    console.log("  node sheets-writer.js setup-database");
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
  setupDatabase,
  logToDashboard,
};
