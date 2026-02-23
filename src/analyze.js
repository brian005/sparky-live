// ============================================================
// ANALYSIS ENGINE v2 — Daily Stats
// ============================================================
// Reads data/daily/*.json files and computes:
//   - Rolling 3D/7D PPG
//   - Day rank streaks (win, podium, bottom-half)
//   - Period projections
//   - VS Projected performance
// ============================================================

const fs = require("fs");
const path = require("path");
const { getPeriodForDate, toFranchise, PERIODS } = require("./config");

const DAILY_DIR = path.join(__dirname, "..", "data", "daily");

/**
 * Load all daily score files, sorted by date ascending.
 * Filters out Olympic break / null period / empty files.
 */
function loadAllDailyScores() {
  if (!fs.existsSync(DAILY_DIR)) return [];

  const files = fs.readdirSync(DAILY_DIR)
    .filter(f => f.endsWith(".json") && f !== ".gitkeep")
    .sort();

  const days = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, file), "utf-8"));
      if (!data.period || !data.teams || data.teams.length === 0) continue;
      // Skip days where every team scored 0 (likely no games)
      const totalPts = data.teams.reduce((sum, t) => sum + (t.dayPts || 0), 0);
      if (totalPts === 0) continue;
      days.push(data);
    } catch (e) {
      // Skip corrupt files
    }
  }

  return days;
}

/**
 * Get days for a specific period only.
 */
function getDaysForPeriod(allDays, period) {
  return allDays.filter(d => d.period === period);
}

/**
 * Compute rolling average PPG over the last N days for a franchise.
 */
function rollingAvgPPG(allDays, franchise, n) {
  const teamDays = allDays
    .filter(d => d.teams.some(t => t.franchise === franchise))
    .slice(-n);

  if (teamDays.length === 0) return null;

  let totalPts = 0;
  let totalGP = 0;

  for (const day of teamDays) {
    const team = day.teams.find(t => t.franchise === franchise);
    if (!team) continue;
    totalPts += team.dayPts || 0;
    totalGP += team.gp || 0;
  }

  if (totalGP > 0) return +(totalPts / totalGP).toFixed(2);
  return +(totalPts / teamDays.length).toFixed(2);
}

/**
 * Compute season-long PPG for a franchise.
 */
function seasonPPG(allDays, franchise) {
  let totalPts = 0;
  let totalGP = 0;
  let dayCount = 0;

  for (const day of allDays) {
    const team = day.teams.find(t => t.franchise === franchise);
    if (!team) continue;
    totalPts += team.dayPts || 0;
    totalGP += team.gp || 0;
    dayCount++;
  }

  if (totalGP > 0) return +(totalPts / totalGP).toFixed(2);
  if (dayCount > 0) return +(totalPts / dayCount).toFixed(2);
  return 0;
}

/**
 * Compute streak/narrative items for a franchise.
 * Guarantees at least one narrative for every team.
 */
function computeStreaks(allDays, franchise) {
  const narratives = [];
  if (allDays.length < 2) return narratives;

  const rankedDays = allDays.map(day => {
    const sorted = [...day.teams].sort((a, b) => (b.dayPts || 0) - (a.dayPts || 0));
    const teamIdx = sorted.findIndex(t => t.franchise === franchise);
    return {
      date: day.date,
      rank: teamIdx >= 0 ? teamIdx + 1 : 7,
      dayPts: sorted[teamIdx]?.dayPts || 0,
    };
  });

  const recent = rankedDays.slice(-30);

  // Win streak
  let winStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank === 1) winStreak++;
    else break;
  }
  if (winStreak >= 2) narratives.push(`🔥 ${winStreak}-day win streak`);

  // Podium streak
  let podiumStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank <= 3) podiumStreak++;
    else break;
  }
  if (podiumStreak >= 3 && winStreak < 2) narratives.push(`📈 ${podiumStreak}-day podium streak`);

  // Bottom half streak
  let bottomStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank > 3) bottomStreak++;
    else break;
  }
  if (bottomStreak >= 5) narratives.push(`⚠️ ${bottomStreak}-day bottom-half streak`);

  // Best day this period
  const currentPeriod = allDays[allDays.length - 1]?.period;
  const periodDays = allDays.filter(d => d.period === currentPeriod);
  if (periodDays.length > 1) {
    const lastDay = periodDays[periodDays.length - 1];
    const teamToday = lastDay.teams.find(t => t.franchise === franchise);
    if (teamToday && (teamToday.dayPts || 0) > 0) {
      const bestInPeriod = periodDays.reduce((best, day) => {
        const t = day.teams.find(t => t.franchise === franchise);
        return t && (t.dayPts || 0) > best ? (t.dayPts || 0) : best;
      }, 0);
      if ((teamToday.dayPts || 0) >= bestInPeriod) {
        narratives.push("⭐ Best day this period");
      }
    }
  }

  return narratives;
}

/**
 * Build a trending narrative from 3D/7D averages vs season PPG.
 * Returns a string like "📈 3D avg: 1.14 (up from 0.92 season)"
 */
function buildTrendNarrative(avg3d, avg7d, ppg) {
  if (avg3d == null || ppg == null) return null;

  const diff3 = avg3d - ppg;
  const pctChange = ppg > 0 ? Math.round((diff3 / ppg) * 100) : 0;

  if (Math.abs(pctChange) < 8) return null; // not significant enough

  if (pctChange >= 20) {
    return `📈 3D avg ${avg3d.toFixed(2)} — surging (+${pctChange}% above season)`;
  } else if (pctChange >= 8) {
    return `📈 3D avg ${avg3d.toFixed(2)} (up from ${ppg.toFixed(2)} season)`;
  } else if (pctChange <= -20) {
    return `📉 3D avg ${avg3d.toFixed(2)} — slumping (${pctChange}% below season)`;
  } else if (pctChange <= -8) {
    return `📉 3D avg ${avg3d.toFixed(2)} (down from ${ppg.toFixed(2)} season)`;
  }

  return null;
}

/**
 * Project period finish based on current pace.
 */
function projectPeriodFinish(allDays, franchise, period) {
  const periodDays = allDays.filter(d => d.period === period);
  if (periodDays.length === 0) return null;

  const periodConfig = PERIODS.find(p => p.period === period);
  if (!periodConfig) return null;

  let periodPts = 0;
  for (const day of periodDays) {
    const team = day.teams.find(t => t.franchise === franchise);
    if (team) periodPts += team.dayPts || 0;
  }

  const daysPlayed = periodDays.length;
  const startDate = new Date(periodConfig.start + "T12:00:00Z");
  const endDate = new Date(periodConfig.end + "T12:00:00Z");
  const totalDays = Math.round((endDate - startDate) / 86400000) + 1;
  const daysRemaining = totalDays - daysPlayed;

  if (daysPlayed === 0) return null;

  const dailyAvg = periodPts / daysPlayed;
  const projected = Math.round(periodPts + dailyAvg * daysRemaining);

  return { periodPts: +periodPts.toFixed(1), projected, daysPlayed, daysRemaining, totalDays };
}

/**
 * Build the full nightly analysis from daily data + today's scrape.
 */
function buildNightlyAnalysis(todayScrape) {
  const allDays = loadAllDailyScores();
  const period = todayScrape.period;
  const today = todayScrape.date || new Date().toISOString().split("T")[0];

  // Build stats for each team
  const teamStats = todayScrape.teams.map(t => {
    const franchise = t.franchise || toFranchise(t.name) || t.name;

    const avg3d = rollingAvgPPG(allDays, franchise, 3);
    const avg7d = rollingAvgPPG(allDays, franchise, 7);
    const ppg = seasonPPG(allDays, franchise);
    const streaks = computeStreaks(allDays, franchise);
    const projection = projectPeriodFinish(allDays, franchise, period);
    const vsProj = t.projPts ? +((t.dayPts || 0) - t.projPts).toFixed(2) : null;

    // Add 3D/7D trend narrative if significant and room for it
    const trendNar = buildTrendNarrative(avg3d, avg7d, ppg);
    if (trendNar && streaks.length < 2) {
      streaks.push(trendNar);
    }

    // Guarantee at least one narrative
    if (streaks.length === 0) {
      if (projection) {
        streaks.push(`Proj finish: ${projection.projected} pts`);
      } else if (ppg) {
        streaks.push(`Season avg: ${ppg.toFixed(2)} PPG`);
      }
    }

    return {
      franchise,
      name: t.name,
      dayPts: t.dayPts || 0,
      projPts: t.projPts || 0,
      gp: t.gp || 0,
      ppg,
      avg3d,
      avg7d,
      vsProj,
      streaks,
      projection,
    };
  });

  // Rank by day score
  const ranked = [...teamStats].sort((a, b) => b.dayPts - a.dayPts);
  ranked.forEach((t, i) => { t.dayRank = i + 1; });

  // Season totals from daily files
  const seasonTotals = {};
  for (const t of teamStats) seasonTotals[t.franchise] = 0;

  for (const day of allDays) {
    for (const t of day.teams) {
      const f = t.franchise || toFranchise(t.name);
      if (f && seasonTotals[f] !== undefined) {
        seasonTotals[f] += t.dayPts || 0;
      }
    }
  }

  // Add today if not in history
  const todayInHistory = allDays.some(d => d.date === today);
  if (!todayInHistory) {
    for (const t of todayScrape.teams) {
      const f = t.franchise || toFranchise(t.name);
      if (f && seasonTotals[f] !== undefined) {
        seasonTotals[f] += t.dayPts || 0;
      }
    }
  }

  for (const t of ranked) {
    t.seasonPts = +(seasonTotals[t.franchise] || 0).toFixed(1);
  }

  const seasonRanked = [...ranked].sort((a, b) => b.seasonPts - a.seasonPts);
  seasonRanked.forEach((t, i) => { t.seasonRank = i + 1; });

  return {
    date: today,
    period,
    scrapedAt: todayScrape.scrapedAt || new Date().toISOString(),
    teams: ranked,       // sorted by day score
    seasonRanked,        // sorted by season total
    periodDaysPlayed: getDaysForPeriod(allDays, period).length,
    totalSeasonDays: allDays.length,
  };
}

/**
 * Save today's scrape as a daily JSON file.
 */
function saveDailyScore(scrapeData, dateStr) {
  if (!fs.existsSync(DAILY_DIR)) {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
  }

  const data = {
    date: dateStr,
    period: scrapeData.period,
    teams: scrapeData.teams.map(t => ({
      franchise: toFranchise(t.name) || t.name,
      name: t.name,
      dayPts: t.dayPts || 0,
      projPts: t.projectedFpg || 0,
      gp: t.gp || 0,
    }))
  };

  const filepath = path.join(DAILY_DIR, `${dateStr}.json`);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`[analyze] Daily score saved: ${dateStr}.json`);
  return data;
}

module.exports = {
  loadAllDailyScores,
  buildNightlyAnalysis,
  saveDailyScore,
  rollingAvgPPG,
  seasonPPG,
  computeStreaks,
  projectPeriodFinish,
};
