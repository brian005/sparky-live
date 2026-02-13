// ============================================================
// EXPORT HISTORY — Apps Script utility
// ============================================================
// Add this function to your Google Sheets Apps Script project.
// Run it to generate a JSON export of the Database tab that
// can be saved as data/historical.json in the sparky-live repo.
// ============================================================
// After running, copy the output from the Logs (View → Logs)
// and save it to sparky-live/data/historical.json
// ============================================================

function exportDatabaseToJSON() {
  const db = readDatabase(); // Uses the existing readDatabase() function
  if (!db) {
    Logger.log("ERROR: No data in Database tab.");
    return;
  }

  // Convert to a clean format for the live scraper
  const output = db.periods.map(p => ({
    season: p.season,
    period: p.period,
    teams: p.teams
  }));

  const json = JSON.stringify(output, null, 2);

  // Log it (copy from View → Logs)
  Logger.log(json);

  // Also write to a sheet for easier copy/paste
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let exportSheet = ss.getSheetByName("JSON Export");
  if (!exportSheet) exportSheet = ss.insertSheet("JSON Export");
  exportSheet.clear();
  exportSheet.getRange("A1").setValue("Copy the JSON below and save as data/historical.json in your sparky-live repo:");
  exportSheet.getRange("A3").setValue(json).setWrap(true);
  exportSheet.setColumnWidth(1, 1000);

  SpreadsheetApp.getUi().alert(
    "✅ JSON exported to 'JSON Export' tab.\n\n" +
    "Copy the contents of cell A3 and save as:\n" +
    "sparky-live/data/historical.json"
  );
}
