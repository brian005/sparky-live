/**
 * historical.js — Fetch and query 13-year league history from Google Sheets.
 *
 * Pulls the "Database" tab from the SPARKY Records & Performance spreadsheet
 * at runtime via public CSV export. Provides lookup functions for all-time
 * period records (league-wide and per-franchise).
 *
 * Database tab columns per owner:
 *   Season | Period | {Owner}_FPts | {Owner}_FP/G | {Owner}_GP | {Owner}_SR
 * Owners: Jason, Brian, Graeme, Chris, Richie, Matt
 */

const SHEET_ID = "1MbusvKdOqOp-TOHIjAW0rQxj_0Z33v1lQFLcnKqaD9Q";
const DATABASE_GID = "268966179";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${DATABASE_GID}`;

// Map Database tab owner names → current franchise codes
const OWNER_TO_FRANCHISE = {
  Jason: "JGC",
  Brian: "BEW",
  Graeme: "GDD",
  Chris: "PWN",
  Richie: "RMS",
  Matt: "MPP",
};

const FRANCHISE_TO_OWNER = {};
for (const [owner, code] of Object.entries(OWNER_TO_FRANCHISE)) {
  FRANCHISE_TO_OWNER[code] = owner;
}

// Cache the parsed data for the lifetime of the process
let _cache = null;

/**
 * Parse CSV text into array of objects using header row.
 */
function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    if (values.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Fetch and parse the Database tab. Returns structured records:
 * [{ season, period, teams: { JGC: { fpts, fpg, gp, sr }, ... } }, ...]
 */
async function fetchHistoricalData() {
  if (_cache) return _cache;

  const resp = await fetch(CSV_URL);
  if (!resp.ok) {
    console.error(`Failed to fetch historical data: ${resp.status}`);
    return [];
  }

  const text = await resp.text();
  const rawRows = parseCSV(text);

  const records = [];
  for (const row of rawRows) {
    const season = parseInt(row.Season);
    const period = parseInt(row.Period);
    if (isNaN(season) || isNaN(period)) continue;

    const teams = {};
    for (const [owner, franchise] of Object.entries(OWNER_TO_FRANCHISE)) {
      const fpts = parseFloat(row[`${owner}_FPts`]) || 0;
      const fpg = parseFloat(row[`${owner}_FP/G`]) || 0;
      const gp = parseInt(row[`${owner}_GP`]) || 0;
      const sr = parseInt(row[`${owner}_SR`]) || 0;

      // Only include if there's data (Richie may not have early seasons)
      if (fpts > 0 || gp > 0) {
        teams[franchise] = { fpts, fpg, gp, sr };
      }
    }

    if (Object.keys(teams).length > 0) {
      records.push({ season, period, teams });
    }
  }

  _cache = records;
  console.log(`📚 Loaded ${records.length} historical period records (${rawRows.length} rows)`);
  return records;
}

/**
 * Get all period totals for a specific period number across all seasons.
 * Returns: [{ season, franchise, fpts, fpg, gp }, ...]
 */
async function getPeriodHistory(periodNumber) {
  const records = await fetchHistoricalData();
  const results = [];

  for (const rec of records) {
    if (rec.period !== periodNumber) continue;
    for (const [franchise, data] of Object.entries(rec.teams)) {
      results.push({
        season: rec.season,
        franchise,
        fpts: data.fpts,
        fpg: data.fpg,
        gp: data.gp,
      });
    }
  }

  return results;
}

/**
 * Get the all-time league record for a given period number.
 * Returns: { franchise, season, fpts, fpg } or null
 */
async function getLeaguePeriodRecord(periodNumber) {
  const history = await getPeriodHistory(periodNumber);
  if (history.length === 0) return null;

  return history.reduce((best, entry) =>
    entry.fpts > best.fpts ? entry : best
  );
}

/**
 * Get a franchise's best period score for a given period number.
 * Returns: { season, fpts, fpg } or null
 */
async function getFranchisePeriodBest(periodNumber, franchise) {
  const history = await getPeriodHistory(periodNumber);
  const mine = history.filter(h => h.franchise === franchise);
  if (mine.length === 0) return null;

  return mine.reduce((best, entry) =>
    entry.fpts > best.fpts ? entry : best
  );
}

/**
 * Get a franchise's all-time best period (any period number).
 * Returns: { season, period, fpts, fpg } or null
 */
async function getFranchiseAllTimeBest(franchise) {
  const records = await fetchHistoricalData();
  let best = null;

  for (const rec of records) {
    const data = rec.teams[franchise];
    if (!data) continue;
    if (!best || data.fpts > best.fpts) {
      best = { season: rec.season, period: rec.period, fpts: data.fpts, fpg: data.fpg };
    }
  }

  return best;
}

/**
 * Get the all-time league record for any period.
 * Returns: { franchise, season, period, fpts, fpg } or null
 */
async function getLeagueAllTimeRecord() {
  const records = await fetchHistoricalData();
  let best = null;

  for (const rec of records) {
    for (const [franchise, data] of Object.entries(rec.teams)) {
      if (!best || data.fpts > best.fpts) {
        best = { franchise, season: rec.season, period: rec.period, fpts: data.fpts, fpg: data.fpg };
      }
    }
  }

  return best;
}

/**
 * Get summary stats for a franchise across all periods.
 * Returns: { totalPeriods, avgFpts, bestFpts, bestSeason, bestPeriod, worstFpts }
 */
async function getFranchiseCareerStats(franchise) {
  const records = await fetchHistoricalData();
  let totalPeriods = 0;
  let totalFpts = 0;
  let best = { fpts: 0 };
  let worst = { fpts: Infinity };

  for (const rec of records) {
    const data = rec.teams[franchise];
    if (!data || data.fpts === 0) continue;

    totalPeriods++;
    totalFpts += data.fpts;

    if (data.fpts > best.fpts) {
      best = { fpts: data.fpts, season: rec.season, period: rec.period };
    }
    if (data.fpts < worst.fpts) {
      worst = { fpts: data.fpts, season: rec.season, period: rec.period };
    }
  }

  if (totalPeriods === 0) return null;

  return {
    totalPeriods,
    avgFpts: Math.round(totalFpts / totalPeriods),
    bestFpts: best.fpts,
    bestSeason: best.season,
    bestPeriod: best.period,
    worstFpts: worst.fpts === Infinity ? 0 : worst.fpts,
    worstSeason: worst.season,
    worstPeriod: worst.period,
  };
}

module.exports = {
  fetchHistoricalData,
  getPeriodHistory,
  getLeaguePeriodRecord,
  getFranchisePeriodBest,
  getFranchiseAllTimeBest,
  getLeagueAllTimeRecord,
  getFranchiseCareerStats,
  OWNER_TO_FRANCHISE,
  FRANCHISE_TO_OWNER,
};
