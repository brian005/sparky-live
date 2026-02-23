// ============================================================
// SPARKY LEAGUE CONFIGURATION
// ============================================================
// Shared constants: periods, franchise mapping, league ID.
// ============================================================

const LEAGUE_ID = "264ojs1imd3nogmp";

const PERIODS = [
  { period: 1,  start: "2025-10-07", end: "2025-10-19" },
  { period: 2,  start: "2025-10-20", end: "2025-11-02" },
  { period: 3,  start: "2025-11-03", end: "2025-11-16" },
  { period: 4,  start: "2025-11-17", end: "2025-11-30" },
  { period: 5,  start: "2025-12-01", end: "2025-12-14" },
  { period: 6,  start: "2025-12-15", end: "2025-12-28" },
  { period: 7,  start: "2025-12-29", end: "2026-01-11" },
  { period: 8,  start: "2026-01-12", end: "2026-01-25" },
  { period: 9,  start: "2026-01-26", end: "2026-02-08" },
  { period: 10, start: "2026-02-23", end: "2026-03-08" },
  { period: 11, start: "2026-03-09", end: "2026-03-22" },
  { period: 12, start: "2026-03-23", end: "2026-04-05" },
  { period: 13, start: "2026-04-06", end: "2026-04-16" },
];

// Map Fantrax team names to franchise abbreviations
const FRANCHISE_MAP = {
  "jason's gaucho chudpumpers": "JGC",
  "gaucho chudpumpers": "JGC",
  "cmack's pwn": "PWN",
  "pwn": "PWN",
  "brian's endless winter": "BEW",
  "endless winter": "BEW",
  "brian's.endless.win ter.s13e01.720p.mp4": "BEW",
  "matt's mid tier perpetual projects": "MPP",
  "mid tier perpetual projects": "MPP",
  "richie's meatspinners": "RMS",
  "meatspinners": "RMS",
  "graeme's downtown demons": "GDD",
  "downtown demons": "GDD",
};

const FRANCHISE_NAMES = {
  JGC: "Gaucho Chudpumpers",
  PWN: "PWN",
  BEW: "Endless Winter",
  MPP: "mid tier perpetual projects",
  RMS: "Meatspinners",
  GDD: "Downtown Demons",
};

/**
 * Get the period number for a given date string (YYYY-MM-DD).
 * Returns null if the date falls outside all periods (e.g. Olympic break).
 */
function getPeriodForDate(dateStr) {
  const match = PERIODS.find(p => dateStr >= p.start && dateStr <= p.end);
  return match ? match.period : null;
}

/**
 * Get today's period number.
 * Uses ET timezone for consistency with NHL schedule.
 */
function getCurrentPeriod() {
  const now = new Date();
  const etDate = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return getPeriodForDate(etDate);
}

/**
 * Resolve a team name to a franchise abbreviation.
 */
function toFranchise(name) {
  if (!name) return null;
  const normalized = name.toLowerCase().trim();
  // Try exact match first
  if (FRANCHISE_MAP[normalized]) return FRANCHISE_MAP[normalized];
  // Try partial match — either direction
  for (const [key, abbr] of Object.entries(FRANCHISE_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) return abbr;
  }
  // Keyword fallback for corrupted names
  const keywords = {
    "gaucho": "JGC", "chudpumper": "JGC",
    "pwn": "PWN",
    "endless": "BEW", "winter": "BEW",
    "perpetual": "MPP", "mid tier": "MPP",
    "meatspinner": "RMS",
    "downtown": "GDD", "demon": "GDD",
  };
  for (const [kw, abbr] of Object.entries(keywords)) {
    if (normalized.includes(kw)) return abbr;
  }
  return null;
}

/**
 * Build a live scoring URL for a specific date.
 */
function buildDateScoringUrl(dateStr) {
  return `https://www.fantrax.com/fantasy/league/${LEAGUE_ID}/livescoring;viewType=1;date=${dateStr}`;
}

/**
 * Build a live scoring URL for a specific period (current day).
 */
function buildPeriodScoringUrl(period) {
  return `https://www.fantrax.com/fantasy/league/${LEAGUE_ID}/livescoring;period=${period};viewType=1`;
}

/**
 * Get all dates in the season that fall within a period.
 */
function getAllSeasonDates() {
  const dates = [];
  for (const p of PERIODS) {
    let current = new Date(p.start + "T12:00:00Z");
    const end = new Date(p.end + "T12:00:00Z");
    while (current <= end) {
      dates.push({
        date: current.toISOString().split("T")[0],
        period: p.period
      });
      current.setDate(current.getDate() + 1);
    }
  }
  return dates;
}

module.exports = {
  LEAGUE_ID,
  PERIODS,
  FRANCHISE_MAP,
  FRANCHISE_NAMES,
  getPeriodForDate,
  getCurrentPeriod,
  toFranchise,
  buildDateScoringUrl,
  buildPeriodScoringUrl,
  getAllSeasonDates,
};
