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
const HISTORICAL_GID = "1933819434";
const DATABASE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${DATABASE_GID}`;
const HISTORICAL_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${HISTORICAL_GID}`;

// Map Database tab owner names → current franchise codes
const OWNER_TO_FRANCHISE = {
  Jason: "JGC",
  Brian: "BEW",
  Graeme: "GDD",
  Chris: "PWN",
  Richie: "RMS",
  Matt: "MPP",
};

// Map Historical tab winner/loser names (same as owner names, plus "Cmack" alias)
const WINNER_NAME_TO_FRANCHISE = {
  ...OWNER_TO_FRANCHISE,
  Cmack: "PWN",
};

const FRANCHISE_TO_OWNER = {};
for (const [owner, code] of Object.entries(OWNER_TO_FRANCHISE)) {
  FRANCHISE_TO_OWNER[code] = owner;
}

// Caches — use promises to prevent duplicate fetches from Promise.all
let _dbPromise = null;
let _histPromise = null;

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
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const resp = await fetch(DATABASE_URL);
    if (!resp.ok) {
      console.error(`Failed to fetch historical data: ${resp.status}`);
      _dbPromise = null;
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

        if (fpts > 0 || gp > 0) {
          teams[franchise] = { fpts, fpg, gp };
        }
      }

      if (Object.keys(teams).length > 0) {
        records.push({ season, period, teams });
      }
    }

    console.log(`📚 Loaded ${records.length} historical period records (${rawRows.length} rows)`);
    return records;
  })();

  return _dbPromise;
}

/**
 * Fetch and parse the Historical tab (winner/loser per period matchup).
 * Returns: [{ season, period, winner, loser, winnerFpts, loserFpts, winnerFpg, loserFpg }, ...]
 */
async function fetchMatchupHistory() {
  if (_histPromise) return _histPromise;

  _histPromise = (async () => {
    const resp = await fetch(HISTORICAL_URL);
    if (!resp.ok) {
      console.error(`Failed to fetch matchup history: ${resp.status}`);
      _histPromise = null;
      return [];
    }

    const text = await resp.text();
    const rawRows = parseCSV(text);

    const records = [];
    for (const row of rawRows) {
      const season = parseInt(row.Season);
      const period = parseInt(row.Period);
      if (isNaN(season) || isNaN(period)) continue;

      const winnerName = (row.Winner || "").trim();
      const loserName = (row.Loser || "").trim();
      const winner = WINNER_NAME_TO_FRANCHISE[winnerName];
      const loser = WINNER_NAME_TO_FRANCHISE[loserName];
      if (!winner || !loser) continue;

      records.push({
        season,
        period,
        winner,
        loser,
        winnerFpts: parseFloat(row.Winner_FPts) || 0,
        loserFpts: parseFloat(row.Loser_FPts) || 0,
        winnerFpg: parseFloat(row["Winner_FP/G"]) || 0,
        loserFpg: parseFloat(row["Loser_FP/G"]) || 0,
      });
    }

    console.log(`📜 Loaded ${records.length} historical matchup records`);
    return records;
  })();

  return _histPromise;
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

// ============================================================
// NEW: Historical narrative query functions
// ============================================================

/**
 * Get career total points for a franchise (sum of all period FPts).
 * Returns: { totalPts, totalPeriods }
 */
async function getCareerTotalPoints(franchise) {
  const records = await fetchHistoricalData();
  let totalPts = 0;
  let totalPeriods = 0;

  for (const rec of records) {
    const data = rec.teams[franchise];
    if (!data || data.fpts === 0) continue;
    totalPts += data.fpts;
    totalPeriods++;
  }

  return { totalPts: Math.round(totalPts), totalPeriods };
}

/**
 * Get period dominance stats — who has won each period number most often.
 * Returns: { wins, totalOccurrences, topWinner, topWinnerWins } for the given franchise + period.
 */
async function getPeriodDominance(periodNumber, franchise) {
  const matchups = await fetchMatchupHistory();
  const periodMatchups = matchups.filter(m => m.period === periodNumber);

  // Count wins per franchise for this period number
  const winCounts = {};
  for (const m of periodMatchups) {
    winCounts[m.winner] = (winCounts[m.winner] || 0) + 1;
  }

  const myWins = winCounts[franchise] || 0;

  // Find the franchise with the most wins for this period
  let topWinner = null;
  let topWinnerWins = 0;
  for (const [f, count] of Object.entries(winCounts)) {
    if (count > topWinnerWins) {
      topWinner = f;
      topWinnerWins = count;
    }
  }

  return {
    wins: myWins,
    totalOccurrences: periodMatchups.length,
    topWinner,
    topWinnerWins,
    winCounts,
  };
}

/**
 * Get H2H record between two franchises for a specific period number.
 * Returns: { winsA, winsB, neverBeaten } or null if they've never matched up.
 */
async function getH2HPeriodRecord(periodNumber, franchiseA, franchiseB) {
  const matchups = await fetchMatchupHistory();
  const relevant = matchups.filter(m =>
    m.period === periodNumber &&
    ((m.winner === franchiseA && m.loser === franchiseB) ||
     (m.winner === franchiseB && m.loser === franchiseA))
  );

  if (relevant.length === 0) return null;

  let winsA = 0;
  let winsB = 0;
  for (const m of relevant) {
    if (m.winner === franchiseA) winsA++;
    else winsB++;
  }

  return {
    winsA,
    winsB,
    total: relevant.length,
    neverBeatenByB: winsB === 0 && winsA > 0,
    neverBeatenByA: winsA === 0 && winsB > 0,
  };
}

/**
 * Get franchise's recent period win/loss streak (across all period numbers).
 * Looks at the most recent N matchups.
 * Returns: { streak, type: "W"|"L", lastWinSeason, lastWinPeriod }
 */
async function getFranchiseMatchupStreak(franchise) {
  const matchups = await fetchMatchupHistory();

  // Get all matchups involving this franchise, sorted by season+period desc
  const mine = matchups
    .filter(m => m.winner === franchise || m.loser === franchise)
    .sort((a, b) => b.season - a.season || b.period - a.period);

  if (mine.length === 0) return null;

  // Count consecutive wins or losses from most recent
  const firstResult = mine[0].winner === franchise ? "W" : "L";
  let streak = 0;
  for (const m of mine) {
    const result = m.winner === franchise ? "W" : "L";
    if (result === firstResult) streak++;
    else break;
  }

  // Find last win if currently on a losing streak
  let lastWin = null;
  if (firstResult === "L") {
    const lastWinMatch = mine.find(m => m.winner === franchise);
    if (lastWinMatch) {
      lastWin = { season: lastWinMatch.season, period: lastWinMatch.period };
    }
  }

  return {
    streak,
    type: firstResult,
    lastWin,
  };
}

/**
 * Get season pace comparison — how does the franchise's current season total
 * through period N compare to their totals through the same period in past seasons?
 * Returns: { currentTotal, historicalPaces: [{ season, totalThroughPeriod }], bestPace, worstPace }
 */
async function getSeasonPace(franchise, currentPeriod, currentSeasonTotal) {
  const records = await fetchHistoricalData();

  // Group by season, sum FPts through the given period number
  const seasonTotals = {};
  for (const rec of records) {
    if (rec.period > currentPeriod) continue;
    const data = rec.teams[franchise];
    if (!data) continue;
    if (!seasonTotals[rec.season]) seasonTotals[rec.season] = 0;
    seasonTotals[rec.season] += data.fpts;
  }

  const paces = Object.entries(seasonTotals)
    .map(([season, total]) => ({ season: parseInt(season), totalThroughPeriod: Math.round(total) }))
    .sort((a, b) => b.totalThroughPeriod - a.totalThroughPeriod);

  if (paces.length === 0) return null;

  return {
    currentTotal: currentSeasonTotal,
    historicalPaces: paces,
    bestPace: paces[0],
    worstPace: paces[paces.length - 1],
  };
}

module.exports = {
  fetchHistoricalData,
  fetchMatchupHistory,
  getPeriodHistory,
  getLeaguePeriodRecord,
  getFranchisePeriodBest,
  getFranchiseAllTimeBest,
  getLeagueAllTimeRecord,
  getFranchiseCareerStats,
  getCareerTotalPoints,
  getPeriodDominance,
  getH2HPeriodRecord,
  getFranchiseMatchupStreak,
  getSeasonPace,
  OWNER_TO_FRANCHISE,
  FRANCHISE_TO_OWNER,
};
