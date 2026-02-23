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

      // Normalize franchise names to canonical abbreviations
      for (const t of data.teams) {
        const resolved = toFranchise(t.franchise) || toFranchise(t.name);
        if (resolved) t.franchise = resolved;
      }

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
 * ================================================================
 * NARRATIVE ENGINE — builds contextual narratives for each team
 * ================================================================
 * Priority order (picks the best 1-2 for the card):
 *   1. Win streak (2+)
 *   2. Podium streak (3+)
 *   3. Bottom-half streak (5+)
 *   4. Best day this period
 *   5. Period rank change (climbed/dropped)
 *   6. Day score vs period average (big day / cold day)
 *   7. Season rank position
 *   8. 3D trending (surging / slumping)
 *   9. Consistency (hit projection X of last 7)
 *  10. Period pace (best/worst period of the season)
 *  11. Comeback/collapse within period
 *  12. Longest drought since top 3
 *  13. All-time period record proximity
 *  14. Projection fallback
 * ================================================================
 */
function buildNarratives(allDays, franchise, period, todayDayPts, projection, avg3d, ppg) {
  const candidates = []; // { priority, text, isBad }

  if (allDays.length < 2) return [];

  // ---- Build ranked history ----
  const rankedDays = allDays.map(day => {
    const sorted = [...day.teams].sort((a, b) => (b.dayPts || 0) - (a.dayPts || 0));
    const teamIdx = sorted.findIndex(t => t.franchise === franchise);
    const teamData = sorted[teamIdx];
    return {
      date: day.date,
      period: day.period,
      rank: teamIdx >= 0 ? teamIdx + 1 : 7,
      dayPts: teamData?.dayPts || 0,
      numTeams: sorted.length,
    };
  });

  const recent = rankedDays.slice(-30);
  const currentPeriod = period;
  const periodDays = allDays.filter(d => d.period === currentPeriod);
  const periodRanked = rankedDays.filter(d => d.period === currentPeriod);

  // ---- 1. Win streak ----
  let winStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank === 1) winStreak++;
    else break;
  }
  if (winStreak >= 2) {
    candidates.push({ priority: 1, text: `🔥 ${winStreak}-day win streak` });
  }

  // ---- 2. Podium streak ----
  let podiumStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank <= 3) podiumStreak++;
    else break;
  }
  if (podiumStreak >= 3 && winStreak < 2) {
    candidates.push({ priority: 2, text: `📈 ${podiumStreak}-day podium streak` });
  }

  // ---- 3. Bottom-half streak ----
  let bottomStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank > 3) bottomStreak++;
    else break;
  }
  if (bottomStreak >= 5) {
    candidates.push({ priority: 3, text: `⚠️ ${bottomStreak}-day bottom-half streak`, isBad: true });
  }

  // ---- 4. Best day this period ----
  if (periodDays.length > 1 && todayDayPts > 0) {
    const allPeriodPts = periodDays.map(day => {
      const t = day.teams.find(t => t.franchise === franchise);
      return t ? (t.dayPts || 0) : 0;
    });
    const bestInPeriod = Math.max(...allPeriodPts);
    if (todayDayPts >= bestInPeriod) {
      candidates.push({ priority: 4, text: "⭐ Best day this period" });
    }
  }

  // ---- 5. Period rank change ----
  if (periodRanked.length >= 2) {
    // Compute cumulative period standings today vs yesterday
    const periodStandings = computePeriodStandings(periodDays, franchise);
    if (periodStandings) {
      const { currentRank, previousRank } = periodStandings;
      if (currentRank < previousRank) {
        candidates.push({ priority: 5, text: `⬆️ Climbed to #${currentRank} in P${currentPeriod}` });
      } else if (currentRank > previousRank) {
        candidates.push({ priority: 5, text: `⬇️ Dropped to #${currentRank} in P${currentPeriod}`, isBad: true });
      }
    }
  }

  // ---- 6. Day score vs period average ----
  if (periodDays.length >= 3 && todayDayPts > 0) {
    let periodTotal = 0;
    let periodCount = 0;
    for (const day of periodDays) {
      const t = day.teams.find(t => t.franchise === franchise);
      if (t) { periodTotal += t.dayPts || 0; periodCount++; }
    }
    const periodAvg = periodCount > 0 ? periodTotal / periodCount : 0;
    if (periodAvg > 0) {
      const pct = Math.round(((todayDayPts - periodAvg) / periodAvg) * 100);
      if (pct >= 40) {
        candidates.push({ priority: 6, text: `💥 ${todayDayPts} pts today vs ${periodAvg.toFixed(1)} period avg` });
      } else if (pct <= -40) {
        candidates.push({ priority: 6, text: `📉 ${todayDayPts} pts today vs ${periodAvg.toFixed(1)} period avg`, isBad: true });
      }
    }
  }

  // ---- 7. Season rank ----
  // Compute from allDays
  const seasonTotals = {};
  for (const day of allDays) {
    for (const t of day.teams) {
      if (!seasonTotals[t.franchise]) seasonTotals[t.franchise] = 0;
      seasonTotals[t.franchise] += t.dayPts || 0;
    }
  }
  const seasonSorted = Object.entries(seasonTotals).sort((a, b) => b[1] - a[1]);
  const seasonRank = seasonSorted.findIndex(([f]) => f === franchise) + 1;
  if (seasonRank === 1) {
    candidates.push({ priority: 7, text: `👑 1st overall (${Math.round(seasonTotals[franchise])} pts)` });
  } else if (seasonRank === seasonSorted.length) {
    candidates.push({ priority: 7, text: `📊 Last overall (${Math.round(seasonTotals[franchise])} pts)`, isBad: true });
  }

  // ---- 8. 3D trending ----
  if (avg3d != null && ppg != null && ppg > 0) {
    const pctChange = Math.round(((avg3d - ppg) / ppg) * 100);
    if (pctChange >= 20) {
      candidates.push({ priority: 8, text: `📈 3D avg ${avg3d.toFixed(2)} — surging (+${pctChange}% vs season)` });
    } else if (pctChange >= 8) {
      candidates.push({ priority: 8, text: `📈 3D avg ${avg3d.toFixed(2)} (up from ${ppg.toFixed(2)} season)` });
    } else if (pctChange <= -20) {
      candidates.push({ priority: 8, text: `📉 3D avg ${avg3d.toFixed(2)} — slumping (${pctChange}% vs season)`, isBad: true });
    } else if (pctChange <= -8) {
      candidates.push({ priority: 8, text: `📉 3D avg ${avg3d.toFixed(2)} (down from ${ppg.toFixed(2)} season)`, isBad: true });
    }
  }

  // ---- 9. Consistency — hit projection X of last 7 ----
  if (recent.length >= 7) {
    const last7 = recent.slice(-7);
    // Approximate: "above average" days as a proxy for hitting projection
    const aboveAvg = last7.filter(d => d.rank <= 3).length;
    if (aboveAvg >= 6) {
      candidates.push({ priority: 9, text: `🎯 Top 3 in ${aboveAvg} of last 7 days` });
    } else if (aboveAvg <= 1) {
      candidates.push({ priority: 9, text: `🎯 Top 3 only ${aboveAvg}x in last 7 days`, isBad: true });
    }
  }

  // ---- 10. Period pace — best/worst of the season ----
  if (periodDays.length >= 3 && projection) {
    const allPeriodProjections = computeAllPeriodTotals(allDays, franchise);
    if (allPeriodProjections.length > 0) {
      const bestPeriod = Math.max(...allPeriodProjections.map(p => p.total));
      const worstPeriod = Math.min(...allPeriodProjections.map(p => p.total));
      const currentPace = projection.projected;

      if (currentPace > bestPeriod * 1.05) {
        candidates.push({ priority: 10, text: `🚀 On pace for best period (${currentPace} proj vs ${Math.round(bestPeriod)} prev best)` });
      } else if (currentPace < worstPeriod * 0.95 && allPeriodProjections.length >= 3) {
        candidates.push({ priority: 10, text: `⚠️ On pace for worst period (${currentPace} proj vs ${Math.round(worstPeriod)} prev worst)`, isBad: true });
      }
    }
  }

  // ---- 11. Comeback/collapse within period ----
  if (periodRanked.length >= 5) {
    const midpoint = Math.floor(periodRanked.length / 2);
    const midRank = computePeriodRankAtDay(periodDays.slice(0, midpoint), franchise);
    const currentRankInPeriod = computePeriodRankAtDay(periodDays, franchise);
    if (midRank && currentRankInPeriod) {
      const jump = midRank - currentRankInPeriod; // positive = improved
      if (jump >= 3) {
        candidates.push({ priority: 11, text: `🔄 Was #${midRank} mid-period, now #${currentRankInPeriod}` });
      } else if (jump <= -3) {
        candidates.push({ priority: 11, text: `🔄 Was #${midRank} mid-period, now #${currentRankInPeriod}`, isBad: true });
      }
    }
  }

  // ---- 12. Longest drought since top 3 ----
  let drought = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank > 3) drought++;
    else break;
  }
  if (drought >= 8 && bottomStreak < 5) { // don't double up with bottom-half streak
    candidates.push({ priority: 12, text: `🏜️ ${drought} days since finishing top 3`, isBad: true });
  }

  // ---- 13. All-time period record proximity ----
  if (projection && periodDays.length >= 5) {
    const allPeriodTotals = computeAllPeriodTotals(allDays, franchise);
    const allTimeBest = allPeriodTotals.length > 0 ? Math.max(...allPeriodTotals.map(p => p.total)) : 0;
    if (allTimeBest > 0 && projection.periodPts > 0) {
      const remaining = allTimeBest - projection.periodPts;
      if (remaining > 0 && remaining <= projection.daysRemaining * 2) {
        candidates.push({ priority: 13, text: `🏆 ${Math.round(remaining)} pts from matching personal best period` });
      }
    }
  }

  // ---- Sort by priority and pick top 2 ----
  candidates.sort((a, b) => a.priority - b.priority);
  const picked = candidates.slice(0, 2).map(c => c.text);

  // ---- Fallback cascade — 6 lenses to fill gaps ----
  // Only fires if we have fewer than 2 narratives from the main detections.
  // Tries each lens in order until we have 2 narratives.

  if (picked.length < 2) {
    const fallbacks = [];

    // Lens 1: Today vs other teams — day rank context
    const todayRank = rankedDays.length > 0 ? rankedDays[rankedDays.length - 1].rank : null;
    const numTeams = rankedDays.length > 0 ? rankedDays[rankedDays.length - 1].numTeams : 6;
    if (todayRank && todayDayPts > 0) {
      // Find who scored most today
      const todayData = allDays[allDays.length - 1];
      if (todayData) {
        const todaySorted = [...todayData.teams].sort((a, b) => (b.dayPts || 0) - (a.dayPts || 0));
        const leader = todaySorted[0];
        if (todayRank === 1 && todaySorted.length > 1) {
          const margin = todayDayPts - (todaySorted[1]?.dayPts || 0);
          if (margin > 0) fallbacks.push(`Won the day by ${Math.round(margin)} pts`);
        } else if (leader && leader.franchise !== franchise) {
          const gap = (leader.dayPts || 0) - todayDayPts;
          if (gap > 0) fallbacks.push(`${Math.round(gap)} pts behind day leader`);
        }
      }
    }

    // Lens 2: Today vs own history — day score relative to own average
    if (todayDayPts > 0 && ppg && ppg > 0) {
      const pctVsSeason = Math.round(((todayDayPts - ppg) / ppg) * 100);
      if (pctVsSeason >= 25) {
        fallbacks.push(`${pctVsSeason}% above season average today`);
      } else if (pctVsSeason <= -25) {
        fallbacks.push(`${Math.abs(pctVsSeason)}% below season average today`);
      }
    }
    // Also: today vs last 7 days
    if (todayDayPts > 0 && recent.length >= 7) {
      const last7Pts = recent.slice(-7).map(d => d.dayPts);
      const avg7 = last7Pts.reduce((s, p) => s + p, 0) / last7Pts.length;
      if (avg7 > 0) {
        const pctVs7 = Math.round(((todayDayPts - avg7) / avg7) * 100);
        if (pctVs7 >= 40) {
          fallbacks.push(`Big day — ${pctVs7}% above 7-day avg`);
        } else if (pctVs7 <= -40) {
          fallbacks.push(`Quiet day — ${Math.abs(pctVs7)}% below 7-day avg`);
        }
      }
    }

    // Lens 3: This period vs other teams — period standing
    if (periodDays.length >= 2) {
      const currentPeriodRank = computePeriodRankAtDay(periodDays, franchise);
      if (currentPeriodRank) {
        // Get period pts for this team and the leader
        const periodTotals = {};
        for (const day of periodDays) {
          for (const t of day.teams) {
            periodTotals[t.franchise] = (periodTotals[t.franchise] || 0) + (t.dayPts || 0);
          }
        }
        const myPeriodPts = periodTotals[franchise] || 0;
        const periodSorted = Object.entries(periodTotals).sort((a, b) => b[1] - a[1]);
        if (currentPeriodRank <= 2 && periodSorted.length > 1) {
          const secondPts = periodSorted[1]?.[1] || 0;
          const lead = myPeriodPts - secondPts;
          if (currentPeriodRank === 1 && lead > 0) {
            fallbacks.push(`Leading P${currentPeriod} by ${Math.round(lead)} pts`);
          } else {
            fallbacks.push(`#${currentPeriodRank} in P${currentPeriod} (${Math.round(myPeriodPts)} pts)`);
          }
        } else if (currentPeriodRank >= numTeams - 1) {
          fallbacks.push(`#${currentPeriodRank} in P${currentPeriod} (${Math.round(myPeriodPts)} pts)`);
        }
      }
    }

    // Lens 4: This period vs own other periods — PPG comparison
    const ownPeriodTotals = computeAllPeriodTotals(allDays, franchise);
    if (ownPeriodTotals.length >= 2 && periodDays.length >= 3) {
      let myPeriodPts = 0;
      for (const day of periodDays) {
        const t = day.teams.find(t => t.franchise === franchise);
        if (t) myPeriodPts += t.dayPts || 0;
      }
      const myPeriodPPG = myPeriodPts / periodDays.length;
      const prevPPGs = ownPeriodTotals
        .filter(p => p.period !== currentPeriod)
        .map(p => {
          const days = allDays.filter(d => d.period === p.period).length;
          return days > 0 ? p.total / days : 0;
        })
        .filter(x => x > 0);

      if (prevPPGs.length > 0) {
        const avgPrevPPG = prevPPGs.reduce((s, x) => s + x, 0) / prevPPGs.length;
        const pctDiff = avgPrevPPG > 0 ? Math.round(((myPeriodPPG - avgPrevPPG) / avgPrevPPG) * 100) : 0;
        if (pctDiff >= 15) {
          fallbacks.push(`P${currentPeriod} pace ${pctDiff}% above career avg`);
        } else if (pctDiff <= -15) {
          fallbacks.push(`P${currentPeriod} pace ${Math.abs(pctDiff)}% below career avg`);
        }
      }
    }

    // Lens 5: Projected vs best/worst ANY team has done this period number
    if (projection && projection.projected > 0) {
      const allTeamPeriodTotals = computeAllTeamPeriodTotals(allDays, currentPeriod);
      if (allTeamPeriodTotals.length > 0) {
        const leagueBest = Math.max(...allTeamPeriodTotals);
        const leagueWorst = Math.min(...allTeamPeriodTotals);
        if (projection.projected > leagueBest * 1.05) {
          fallbacks.push(`Proj ${projection.projected} — would be best-ever P${currentPeriod}`);
        } else if (projection.projected < leagueWorst * 0.95 && allTeamPeriodTotals.length >= 3) {
          fallbacks.push(`Proj ${projection.projected} — tracking worst-ever P${currentPeriod}`);
        }
      }
    }

    // Lens 6: Projected vs own best/worst in same period number historically
    // (We only have current season data, so compare across this season's periods)
    if (projection && ownPeriodTotals.length >= 2) {
      const bestOwn = Math.max(...ownPeriodTotals.map(p => p.total));
      const worstOwn = Math.min(...ownPeriodTotals.map(p => p.total));
      if (projection.projected > bestOwn * 1.03 && bestOwn > 0) {
        fallbacks.push(`On pace for personal best period (${projection.projected} proj)`);
      } else if (projection.projected < worstOwn * 0.97 && ownPeriodTotals.length >= 3) {
        fallbacks.push(`On pace for personal worst period (${projection.projected} proj)`);
      }
    }

    // Fill remaining slots from fallbacks
    for (const fb of fallbacks) {
      if (picked.length >= 2) break;
      if (!picked.includes(fb)) picked.push(fb);
    }

    // Absolute last resort
    if (picked.length === 0) {
      if (projection) {
        picked.push(`Proj finish: ${projection.projected} pts`);
      } else if (ppg) {
        picked.push(`Season avg: ${ppg.toFixed(2)} PPG`);
      }
    }
  }

  return picked;
}

// ---- Narrative Helpers ----

/**
 * Compute cumulative period standings as of today vs yesterday.
 */
function computePeriodStandings(periodDays, franchise) {
  if (periodDays.length < 2) return null;

  function rankInDays(days) {
    const totals = {};
    for (const day of days) {
      for (const t of day.teams) {
        if (!totals[t.franchise]) totals[t.franchise] = 0;
        totals[t.franchise] += t.dayPts || 0;
      }
    }
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const idx = sorted.findIndex(([f]) => f === franchise);
    return idx >= 0 ? idx + 1 : null;
  }

  const currentRank = rankInDays(periodDays);
  const previousRank = rankInDays(periodDays.slice(0, -1));
  if (currentRank == null || previousRank == null) return null;

  return { currentRank, previousRank };
}

/**
 * Compute a team's rank in cumulative period standings up to a given set of days.
 */
function computePeriodRankAtDay(days, franchise) {
  const totals = {};
  for (const day of days) {
    for (const t of day.teams) {
      if (!totals[t.franchise]) totals[t.franchise] = 0;
      totals[t.franchise] += t.dayPts || 0;
    }
  }
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const idx = sorted.findIndex(([f]) => f === franchise);
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Compute total points for each completed period for a franchise.
 * Returns array of { period, total }.
 */
function computeAllPeriodTotals(allDays, franchise) {
  const periodMap = {};
  for (const day of allDays) {
    if (!day.period) continue;
    if (!periodMap[day.period]) periodMap[day.period] = 0;
    const t = day.teams.find(t => t.franchise === franchise);
    if (t) periodMap[day.period] += t.dayPts || 0;
  }

  // Only include periods that appear complete (7+ days)
  const periodDayCounts = {};
  for (const day of allDays) {
    if (!day.period) continue;
    periodDayCounts[day.period] = (periodDayCounts[day.period] || 0) + 1;
  }

  return Object.entries(periodMap)
    .filter(([p]) => periodDayCounts[p] >= 7)
    .map(([p, total]) => ({ period: +p, total }));
}

/**
 * Compute total points for ALL teams in completed instances of a specific period number.
 * Returns flat array of totals (one per team per completed period).
 * Used for Lens 5: "what's the best/worst anyone has done in this period?"
 */
function computeAllTeamPeriodTotals(allDays, periodNumber) {
  // Find all days in the same period number from previous completions
  // (only same period number, not current — we want historical benchmarks)
  const periodDays = allDays.filter(d => d.period === periodNumber);
  if (periodDays.length < 7) return []; // not enough data

  // Sum per franchise
  const totals = {};
  for (const day of periodDays) {
    for (const t of day.teams) {
      if (!totals[t.franchise]) totals[t.franchise] = 0;
      totals[t.franchise] += t.dayPts || 0;
    }
  }

  return Object.values(totals).filter(v => v > 0);
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
    const franchise = toFranchise(t.franchise) || toFranchise(t.name) || t.franchise || t.name;

    const avg3d = rollingAvgPPG(allDays, franchise, 3);
    const avg7d = rollingAvgPPG(allDays, franchise, 7);
    const ppg = seasonPPG(allDays, franchise);
    const projection = projectPeriodFinish(allDays, franchise, period);
    const vsProj = t.projPts ? +((t.dayPts || 0) - t.projPts).toFixed(2) : null;

    // Build rich narratives (picks best 1-2 automatically)
    const streaks = buildNarratives(allDays, franchise, period, t.dayPts || 0, projection, avg3d, ppg);

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
      periodPts: projection ? projection.periodPts : 0,
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
  buildNarratives,
  projectPeriodFinish,
};
