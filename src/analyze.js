// ============================================================
// ANALYSIS ENGINE
// ============================================================
// Compares current scrape to previous snapshot.
// Builds context package combining live data + historical records.
// ============================================================

const fs = require("fs");
const path = require("path");

const SNAPSHOTS_DIR = path.join(__dirname, "..", "data", "snapshots");
const HISTORY_FILE = path.join(__dirname, "..", "data", "historical.json");

// Franchise name → ID mapping (same as FRANCHISE_MAP in Apps Script)
const FRANCHISE_MAP = {
  "jason's gaucho chudpumpers": "Jason",
  "matt's mid tier perpetual projects": "Matt",
  "graeme's downtown demons": "Graeme",
  "cmack's pwn": "Chris",
  "richie's meatspinners": "Richie",
  "brian's.endless.win ter.s13e01.720p.mp4": "Brian",
  "brian's.endless.winter.s13e01.720p.mp4": "Brian"
};

function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/[\s.]+/g, "");
}

function resolveFranchise(teamName) {
  const lower = String(teamName).trim().toLowerCase();

  // Exact match
  if (FRANCHISE_MAP[lower]) return FRANCHISE_MAP[lower];

  // Normalized match
  const normalized = normalizeName(teamName);
  for (const [key, id] of Object.entries(FRANCHISE_MAP)) {
    if (normalizeName(key) === normalized) return id;
  }

  // Partial match — check if any key is contained in the name
  for (const [key, id] of Object.entries(FRANCHISE_MAP)) {
    if (normalized.includes(normalizeName(key)) || normalizeName(key).includes(normalized)) {
      return id;
    }
  }

  // Try to match on first name
  const firstWord = lower.split(/[''`]/)[0].trim();
  const knownFirstNames = { "jason": "Jason", "matt": "Matt", "graeme": "Graeme",
    "cmack": "Chris", "chris": "Chris", "richie": "Richie", "brian": "Brian" };
  if (knownFirstNames[firstWord]) return knownFirstNames[firstWord];

  return teamName; // Return original if no match
}

/**
 * Ensure snapshots directory exists.
 */
function ensureSnapshotsDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

/**
 * Save a scrape snapshot to disk.
 */
function saveSnapshot(scrapeData) {
  ensureSnapshotsDir();
  const filename = `snapshot_${scrapeData.period}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(scrapeData, null, 2));
  console.log(`[analyze] Snapshot saved: ${filename}`);
  return filepath;
}

/**
 * Get the most recent previous snapshot for this period.
 */
function getPreviousSnapshot(period) {
  ensureSnapshotsDir();
  const files = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(`snapshot_${period}_`) && f.endsWith(".json"))
    .sort()
    .reverse();

  // Skip the most recent (that's the one we just saved) — get the one before
  if (files.length < 2) return null;

  const filepath = path.join(SNAPSHOTS_DIR, files[1]);
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

/**
 * Load historical data (exported from Google Sheets Database tab).
 * Expected format: array of period objects matching the Database structure.
 */
function loadHistorical() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log("[analyze] No historical.json found — commentary will lack historical context.");
    return null;
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
}

/**
 * Build the full analysis context for Claude.
 * 
 * Returns a structured object with:
 * - current: current scrape data with resolved franchise names
 * - changes: what changed since last scrape
 * - historical: relevant historical context
 */
function buildContext(scrapeData) {
  // Resolve franchise names
  const teams = scrapeData.teams.map(t => ({
    ...t,
    franchise: resolveFranchise(t.name)
  }));

  // Sort by season points descending for current standings
  const standings = [...teams].sort((a, b) => b.seasonPts - a.seasonPts);

  // Get previous snapshot and compute changes
  const previous = getPreviousSnapshot(scrapeData.period);
  let changes = null;

  if (previous) {
    const prevTeams = previous.teams.map(t => ({
      ...t,
      franchise: resolveFranchise(t.name)
    }));

    changes = {
      timeSinceLast: timeDiff(previous.scrapedAt, scrapeData.scrapedAt),
      movements: []
    };

    for (const team of standings) {
      const prevTeam = prevTeams.find(t => t.franchise === team.franchise);
      if (!prevTeam) continue;

      const ptsDiff = team.seasonPts - prevTeam.seasonPts;
      const prevRank = [...prevTeams].sort((a, b) => b.seasonPts - a.seasonPts)
        .findIndex(t => t.franchise === team.franchise) + 1;
      const currentRank = standings.findIndex(t => t.franchise === team.franchise) + 1;
      const rankChange = prevRank - currentRank; // positive = moved up

      if (ptsDiff !== 0 || rankChange !== 0) {
        changes.movements.push({
          franchise: team.franchise,
          ptsDiff,
          prevPts: prevTeam.seasonPts,
          newPts: team.seasonPts,
          prevRank,
          currentRank,
          rankChange
        });
      }
    }
  }

  // Load historical context
  const historical = loadHistorical();
  let historicalContext = null;

  if (historical) {
    historicalContext = buildHistoricalContext(standings, scrapeData.period, historical);
  }

  return {
    scrapedAt: scrapeData.scrapedAt,
    period: scrapeData.period,
    standings,
    changes,
    historicalContext
  };
}

/**
 * Build historical comparisons relevant to current standings.
 */
function buildHistoricalContext(standings, period, historical) {
  // historical.json should be an array of period records
  // Each: { season, period, teams: { Jason: { FPts, "FP/G", GP }, ... } }

  const leader = standings[0];
  const last = standings[standings.length - 1];
  const gap = leader.seasonPts - last.seasonPts;

  // Find same-period historical winners
  const samePeriodWinners = historical
    .filter(p => p.period === period)
    .map(p => {
      const entries = Object.entries(p.teams || {})
        .filter(([_, stats]) => stats.FPts > 0)
        .sort((a, b) => b[1].FPts - a[1].FPts);
      if (entries.length === 0) return null;
      return { season: p.season, franchise: entries[0][0], FPts: entries[0][1].FPts };
    })
    .filter(Boolean);

  // Leader's historical records
  const leaderHistory = historical
    .filter(p => p.teams && p.teams[leader.franchise])
    .map(p => ({ season: p.season, period: p.period, FPts: p.teams[leader.franchise].FPts }));

  const leaderBest = leaderHistory.length > 0
    ? leaderHistory.reduce((b, h) => h.FPts > b.FPts ? h : b, leaderHistory[0])
    : null;

  const leaderAvg = leaderHistory.length > 0
    ? leaderHistory.reduce((s, h) => s + h.FPts, 0) / leaderHistory.length
    : 0;

  return {
    samePeriodWinners,
    leaderFranchiseBest: leaderBest,
    leaderFranchiseAvg: leaderAvg.toFixed(1),
    totalHistoricalPeriods: historical.length
  };
}

function timeDiff(isoA, isoB) {
  const diff = Math.abs(new Date(isoB) - new Date(isoA));
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

module.exports = { buildContext, saveSnapshot, resolveFranchise, FRANCHISE_MAP };
