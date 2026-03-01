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
const { getPeriodForDate, toFranchise, PERIODS, FRANCHISE_NAMES } = require("./config");
const { getLeaguePeriodRecord, getFranchisePeriodBest, getFranchiseCareerStats,
        getCareerTotalPoints, getPeriodDominance, getH2HPeriodRecord,
        getFranchiseMatchupStreak, getSeasonPace, getPeriodHistory, FRANCHISE_TO_OWNER } = require("./historical");

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
async function buildNarratives(allDays, franchise, period, todayDayPts, todayGP, projection, avg3d, ppg, todayScrapeTeams) {
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

  // ============================================================
  // IMPACT SCORING — each narrative gets a dynamic score (0-100)
  // based on how remarkable/interesting it actually is.
  // Higher score = more interesting. Top 2 scores win.
  // ============================================================

  const periodConfig = PERIODS.find(p => p.period === currentPeriod);
  const periodTotalDays = periodConfig
    ? Math.round((new Date(periodConfig.end) - new Date(periodConfig.start)) / 86400000) + 1
    : 14;
  const periodProgress = periodDays.length / periodTotalDays; // 0.0 to 1.0
  const inBackHalf = periodProgress >= 0.5;

  // ---- 1. Win streak ----
  let winStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank === 1) winStreak++;
    else break;
  }
  if (winStreak >= 2) {
    // 2-day = 55, 3-day = 70, 5-day = 90+
    const score = Math.min(95, 40 + winStreak * 15);
    candidates.push({ score, text: `🔥 ${winStreak}-day win streak` });
  }

  // ---- 2. Podium streak ----
  let podiumStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank <= 3) podiumStreak++;
    else break;
  }
  if (podiumStreak >= 3 && winStreak < 2) {
    // 3-day = 45, 5-day = 65, 7-day = 85
    const score = Math.min(90, 25 + podiumStreak * 10);
    candidates.push({ score, text: `📈 ${podiumStreak}-day podium streak` });
  }

  // ---- 3. Bottom-half streak ----
  let bottomStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank > 3) bottomStreak++;
    else break;
  }
  if (bottomStreak >= 5) {
    const score = Math.min(85, 30 + bottomStreak * 7);
    candidates.push({ score, text: `⚠️ ${bottomStreak}-day bottom-half streak`, isBad: true });
  }

  // ---- 4. Best day this period ----
  // Only in back half; score increases with how deep into the period we are
  if (inBackHalf && periodDays.length > 1 && todayDayPts > 0) {
    const allPeriodPts = periodDays.map(day => {
      const t = day.teams.find(t => t.franchise === franchise);
      return t ? (t.dayPts || 0) : 0;
    });
    const bestInPeriod = Math.max(...allPeriodPts);
    if (todayDayPts >= bestInPeriod) {
      // Day 8 of 14 = 40, Day 13 of 14 = 60
      const score = 30 + Math.round(periodProgress * 35);
      candidates.push({ score, text: `⭐ Best day this period (so far)` });
    }
  }

  // ---- 5. Period rank change ----
  // Score depends on magnitude of change AND period depth
  if (periodRanked.length >= 2) {
    const periodStandings = computePeriodStandings(periodDays, franchise);
    if (periodStandings) {
      const { currentRank, previousRank } = periodStandings;
      const change = Math.abs(currentRank - previousRank);
      if (currentRank < previousRank) {
        // Climbing to #1 is exciting; climbing to #5 early in period is boring
        // Base: 15, + change magnitude, + period depth, + bonus for top positions
        const positionBonus = currentRank <= 2 ? 15 : 0;
        const score = 15 + change * 10 + Math.round(periodProgress * 20) + positionBonus;
        candidates.push({ score, text: `⬆️ Climbed to #${currentRank} in P${currentPeriod}` });
      } else if (currentRank > previousRank) {
        const positionPenalty = currentRank >= 5 ? 10 : 0;
        const score = 15 + change * 10 + Math.round(periodProgress * 20) + positionPenalty;
        candidates.push({ score, text: `⬇️ Dropped to #${currentRank} in P${currentPeriod}`, isBad: true });
      }
    }
  }

  // ---- 6. Today's PPG vs period PPG average ----
  if (periodDays.length >= 3 && todayGP > 0) {
    const todayPPG = todayDayPts / todayGP;
    let periodTotal = 0;
    let periodGP = 0;
    for (const day of periodDays) {
      const t = day.teams.find(t => t.franchise === franchise);
      if (t) { periodTotal += t.dayPts || 0; periodGP += t.gp || 0; }
    }
    const periodPPG = periodGP > 0 ? periodTotal / periodGP : 0;
    if (periodPPG > 0) {
      const pct = Math.round(((todayPPG - periodPPG) / periodPPG) * 100);
      if (pct >= 30) {
        // 30% over = 40, 60% over = 55, 100% over = 70
        const score = Math.min(75, 30 + Math.round(Math.abs(pct) * 0.4));
        candidates.push({ score, text: `💥 ${todayPPG.toFixed(2)} PPG today vs ${periodPPG.toFixed(2)} period avg` });
      } else if (pct <= -30) {
        const score = Math.min(75, 30 + Math.round(Math.abs(pct) * 0.4));
        candidates.push({ score, text: `📉 ${todayPPG.toFixed(2)} PPG today vs ${periodPPG.toFixed(2)} period avg`, isBad: true });
      }
    }
  }

  // ---- 7. Season rank ----
  // Only interesting as context, low score unless it's a dramatic position
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
    candidates.push({ score: 35, text: `👑 1st overall (${Math.round(seasonTotals[franchise])} pts)` });
  } else if (seasonRank === seasonSorted.length) {
    candidates.push({ score: 30, text: `📊 Last overall (${Math.round(seasonTotals[franchise])} pts)`, isBad: true });
  }

  // ---- 8. 3D trending ----
  if (avg3d != null && ppg != null && ppg > 0) {
    const pctChange = Math.round(((avg3d - ppg) / ppg) * 100);
    if (pctChange >= 20) {
      const score = Math.min(70, 40 + Math.round(Math.abs(pctChange) * 0.5));
      candidates.push({ score, text: `📈 3D avg ${avg3d.toFixed(2)} — surging (+${pctChange}% vs season)` });
    } else if (pctChange >= 8) {
      candidates.push({ score: 30, text: `📈 3D avg ${avg3d.toFixed(2)} (up from ${ppg.toFixed(2)} season)` });
    } else if (pctChange <= -20) {
      const score = Math.min(70, 40 + Math.round(Math.abs(pctChange) * 0.5));
      candidates.push({ score, text: `📉 3D avg ${avg3d.toFixed(2)} — slumping (${pctChange}% vs season)`, isBad: true });
    } else if (pctChange <= -8) {
      candidates.push({ score: 30, text: `📉 3D avg ${avg3d.toFixed(2)} (down from ${ppg.toFixed(2)} season)`, isBad: true });
    }
  }

  // ---- 9. Consistency ----
  if (recent.length >= 7) {
    const last7 = recent.slice(-7);
    const aboveAvg = last7.filter(d => d.rank <= 3).length;
    if (aboveAvg >= 6) {
      candidates.push({ score: 45, text: `🎯 Top 3 in ${aboveAvg} of last 7 days` });
    } else if (aboveAvg <= 1) {
      candidates.push({ score: 40, text: `🎯 Top 3 only ${aboveAvg}x in last 7 days`, isBad: true });
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
        candidates.push({ score: 55, cat: "proj", text: `🚀 On pace for best period (${currentPace} proj vs ${Math.round(bestPeriod)} prev best)` });
      } else if (currentPace < worstPeriod * 0.95 && allPeriodProjections.length >= 3) {
        candidates.push({ score: 50, cat: "proj", text: `⚠️ On pace for worst period (${currentPace} proj vs ${Math.round(worstPeriod)} prev worst)`, isBad: true });
      }
    }
  }

  // ---- 11. Comeback/collapse within period ----
  if (periodRanked.length >= 5) {
    const midpoint = Math.floor(periodRanked.length / 2);
    const midRank = computePeriodRankAtDay(periodDays.slice(0, midpoint), franchise);
    const currentRankInPeriod = computePeriodRankAtDay(periodDays, franchise);
    if (midRank && currentRankInPeriod) {
      const jump = midRank - currentRankInPeriod;
      if (jump >= 3) {
        candidates.push({ score: 55, text: `🔄 Was #${midRank} mid-period, now #${currentRankInPeriod}` });
      } else if (jump <= -3) {
        candidates.push({ score: 50, text: `🔄 Was #${midRank} mid-period, now #${currentRankInPeriod}`, isBad: true });
      }
    }
  }

  // ---- 12. Drought ----
  let drought = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].rank > 3) drought++;
    else break;
  }
  if (drought >= 8 && bottomStreak < 5) {
    const score = Math.min(60, 30 + drought * 3);
    candidates.push({ score, text: `🏜️ ${drought} days since finishing top 3`, isBad: true });
  }

  // ---- 13. Period record proximity (this season) ----
  if (projection && periodDays.length >= 5) {
    const allPeriodTotals = computeAllPeriodTotals(allDays, franchise);
    const allTimeBest = allPeriodTotals.length > 0 ? Math.max(...allPeriodTotals.map(p => p.total)) : 0;
    if (allTimeBest > 0 && projection.periodPts > 0) {
      const remaining = allTimeBest - projection.periodPts;
      if (remaining > 0 && remaining <= projection.daysRemaining * 2) {
        candidates.push({ score: 50, cat: "proj", text: `🏆 ${Math.round(remaining)} pts from matching personal best period` });
      }
    }
  }

  // ---- HISTORICAL COLOR — compete on equal footing ----
  try {
    // Career milestone proximity (very rare, very high impact)
    const career = await getCareerTotalPoints(franchise);
    if (career.totalPts > 0) {
      const milestones = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 12500, 15000];
      const currentPeriodPts = projection ? projection.periodPts : 0;
      const approxCurrentTotal = career.totalPts + currentPeriodPts;
      for (const m of milestones) {
        const remaining = m - approxCurrentTotal;
        if (remaining > 0 && remaining <= 20) {
          candidates.push({ score: 85, text: `🏅 ${remaining} pts from ${m.toLocaleString()} career points` });
          break;
        } else if (remaining > 0 && remaining <= 50) {
          candidates.push({ score: 70, text: `🏅 ${remaining} pts from ${m.toLocaleString()} career points` });
          break;
        } else if (remaining > 0 && remaining <= 100) {
          candidates.push({ score: 55, text: `🏅 ${remaining} pts from ${m.toLocaleString()} career points` });
          break;
        } else if (remaining <= 0 && remaining > -5) {
          candidates.push({ score: 90, text: `🏅 Just crossed ${m.toLocaleString()} career points!` });
          break;
        }
      }
    }

    // Season pace vs historical seasons
    if (projection && currentPeriod >= 3) {
      const currentSeasonPts = allDays.reduce((sum, day) => {
        const team = day.teams.find(t => t.franchise === franchise);
        return sum + (team ? team.dayPts : 0);
      }, 0);

      const pace = await getSeasonPace(franchise, currentPeriod, Math.round(currentSeasonPts));
      if (pace && pace.historicalPaces.length >= 2) {
        const bestEver = pace.bestPace;
        const worstEver = pace.worstPace;
        if (currentSeasonPts > bestEver.totalThroughPeriod) {
          candidates.push({ score: 65, text: `📈 Best-ever pace through P${currentPeriod} (prev: ${bestEver.totalThroughPeriod} in ${bestEver.season})` });
        } else if (currentSeasonPts >= bestEver.totalThroughPeriod * 0.95) {
          candidates.push({ score: 50, text: `📈 Tracking near best-ever pace through P${currentPeriod} (record: ${bestEver.totalThroughPeriod} in ${bestEver.season})` });
        } else if (currentSeasonPts < worstEver.totalThroughPeriod * 1.05 && pace.historicalPaces.length >= 4) {
          candidates.push({ score: 50, text: `📉 Slowest pace through P${currentPeriod} since ${worstEver.season}` });
        }
      }
    }

    // Period dominance
    const dominance = await getPeriodDominance(currentPeriod, franchise);
    if (dominance.totalOccurrences >= 3) {
      if (dominance.wins >= 3) {
        candidates.push({ score: 55, text: `👑 Has won P${currentPeriod} ${dominance.wins} times — most in league history` });
      } else if (dominance.wins === 0 && dominance.totalOccurrences >= 5) {
        candidates.push({ score: 50, text: `🏜️ Has never won a P${currentPeriod} (0-for-${dominance.totalOccurrences} all-time)` });
      } else if (dominance.topWinner && dominance.topWinner !== franchise && dominance.topWinnerWins >= 3) {
        const ownerName = FRANCHISE_TO_OWNER[dominance.topWinner] || dominance.topWinner;
        candidates.push({ score: 40, text: `📊 P${currentPeriod} belongs to ${ownerName} (${dominance.topWinnerWins} wins all-time)` });
      }
    }

    // H2H "never beaten" — only if top 2 in current period
    if (todayScrapeTeams && todayScrapeTeams.length > 0 && periodDays.length >= 3) {
      const periodStandings = computePeriodStandings(periodDays, franchise);
      if (periodStandings && periodStandings.currentRank <= 2) {
        const allPeriodRanks = [];
        for (const t of todayScrapeTeams) {
          const f = toFranchise(t.franchise) || toFranchise(t.name) || t.franchise;
          const standing = computePeriodStandings(periodDays, f);
          if (standing) allPeriodRanks.push({ franchise: f, rank: standing.currentRank });
        }
        allPeriodRanks.sort((a, b) => a.rank - b.rank);
        const rival = allPeriodRanks.find(r => r.franchise !== franchise && r.rank <= 2);

        if (rival) {
          const h2h = await getH2HPeriodRecord(currentPeriod, franchise, rival.franchise);
          if (h2h) {
            const rivalName = FRANCHISE_NAMES[rival.franchise] || rival.franchise;
            if (h2h.neverBeatenByB && h2h.total >= 3) {
              candidates.push({ score: 60, text: `💪 Undefeated vs ${rivalName} in P${currentPeriod} (${h2h.winsA}-0 all-time)` });
            } else if (h2h.neverBeatenByA && h2h.total >= 3) {
              candidates.push({ score: 55, text: `😬 Never beaten ${rivalName} in P${currentPeriod} (0-${h2h.winsB} all-time)` });
            }
          }
        }
      }
    }

    // Franchise hot/cold streak across periods
    const streak = await getFranchiseMatchupStreak(franchise);
    if (streak) {
      if (streak.type === "W" && streak.streak >= 3) {
        const score = Math.min(80, 40 + streak.streak * 10);
        candidates.push({ score, text: `🔥 ${streak.streak}-period win streak` });
      } else if (streak.type === "L" && streak.streak >= 3 && streak.lastWin) {
        const score = Math.min(75, 35 + streak.streak * 10);
        candidates.push({ score, text: `❄️ Hasn't won a period since P${streak.lastWin.period} ${streak.lastWin.season}` });
      }
    }
    // Projection confidence: scales 0.4 (day 2) → 1.0 (day 10+)
    // Early projections are noisy and shouldn't dominate
    const projConfidence = projection
      ? Math.min(1.0, 0.3 + (projection.daysPlayed / projection.totalDays) * 0.9)
      : 0;

    // Projected vs all-time league record for this period number (13-year history)
    if (projection && projection.projected > 0) {
      const leagueRecord = await getLeaguePeriodRecord(currentPeriod);
      if (leagueRecord && leagueRecord.fpts > 0) {
        const recordHolder = FRANCHISE_NAMES[leagueRecord.franchise] || leagueRecord.franchise;
        if (projection.projected > leagueRecord.fpts) {
          candidates.push({ score: Math.round(80 * projConfidence), cat: "proj", text: `🏆 Proj ${projection.projected} — would beat all-time P${currentPeriod} record (${Math.round(leagueRecord.fpts)} by ${recordHolder}, ${leagueRecord.season})` });
        } else if (projection.projected >= leagueRecord.fpts * 0.9) {
          candidates.push({ score: Math.round(60 * projConfidence), cat: "proj", text: `🏆 Proj ${projection.projected} — closing on P${currentPeriod} record (${Math.round(leagueRecord.fpts)} by ${recordHolder}, ${leagueRecord.season})` });
        }
      }

      // Also check league worst for this period number
      const periodHistory = await getPeriodHistory(currentPeriod);
      if (periodHistory.length >= 6) {
        const leagueWorst = periodHistory.reduce((worst, entry) =>
          entry.fpts < worst.fpts ? entry : worst
        );
        if (leagueWorst && projection.projected < leagueWorst.fpts) {
          const worstHolder = FRANCHISE_NAMES[leagueWorst.franchise] || leagueWorst.franchise;
          candidates.push({ score: Math.round(65 * projConfidence), cat: "proj", text: `📉 Proj ${projection.projected} — tracking worst P${currentPeriod} in league history (${Math.round(leagueWorst.fpts)} by ${worstHolder}, ${leagueWorst.season})` });
        }
      }
    }

    // Projected vs franchise's own best/worst for this period number (13-year history)
    if (projection && projection.projected > 0) {
      const myBest = await getFranchisePeriodBest(currentPeriod, franchise);
      if (myBest && myBest.fpts > 0) {
        if (projection.projected > myBest.fpts) {
          candidates.push({ score: Math.round(70 * projConfidence), cat: "proj", text: `📈 Proj ${projection.projected} — would be personal best P${currentPeriod} (prev: ${Math.round(myBest.fpts)} in ${myBest.season})` });
        } else if (projection.projected >= myBest.fpts * 0.9) {
          candidates.push({ score: Math.round(45 * projConfidence), cat: "proj", text: `📈 Proj ${projection.projected} — nearing personal best P${currentPeriod} (${Math.round(myBest.fpts)} in ${myBest.season})` });
        }
      }

      // Franchise's own worst for this period number
      const periodHistory = await getPeriodHistory(currentPeriod);
      const myHistory = periodHistory.filter(h => h.franchise === franchise);
      if (myHistory.length >= 3) {
        const myWorst = myHistory.reduce((worst, entry) =>
          entry.fpts < worst.fpts ? entry : worst
        );
        if (myWorst && projection.projected < myWorst.fpts) {
          candidates.push({ score: Math.round(55 * projConfidence), cat: "proj", text: `📉 Proj ${projection.projected} — tracking personal worst P${currentPeriod} (prev: ${Math.round(myWorst.fpts)} in ${myWorst.season})` });
        }
      }
    }
  } catch (e) {
    console.log(`  ⚠️ Historical data fetch failed: ${e.message}`);
  }

  // ---- Pick top 2 by impact score, avoiding duplicate categories ----
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  const usedCats = new Set();
  for (const c of candidates) {
    if (picked.length >= 2) break;
    // If this candidate has a category and we already used it, skip
    if (c.cat && usedCats.has(c.cat)) continue;
    picked.push(c.text);
    if (c.cat) usedCats.add(c.cat);
  }

  // ---- Fallback lenses (only if still need narratives) ----

  if (picked.length < 2) {
    const fallbacks = [];

    // Lens 1: Today vs other teams — day rank context
    // Use the live scraped data from today (passed in), not historical files
    if (todayScrapeTeams && todayScrapeTeams.length > 0 && todayDayPts > 0) {
      const todaySorted = [...todayScrapeTeams].sort((a, b) => (b.dayPts || 0) - (a.dayPts || 0));
      const myRankToday = todaySorted.findIndex(t => {
        const f = toFranchise(t.franchise) || toFranchise(t.name) || t.franchise;
        return f === franchise;
      }) + 1;
      const leader = todaySorted[0];
      const leaderFranchise = toFranchise(leader.franchise) || toFranchise(leader.name) || leader.franchise;

      if (myRankToday === 1 && todaySorted.length > 1) {
        const margin = todayDayPts - (todaySorted[1]?.dayPts || 0);
        if (margin > 0) fallbacks.push(`Won the day by ${Math.round(margin)} pts`);
      } else if (leader && leaderFranchise !== franchise) {
        const gap = (leader.dayPts || 0) - todayDayPts;
        const leaderName = FRANCHISE_NAMES[leaderFranchise] || leaderFranchise;
        if (gap > 0) fallbacks.push(`${Math.round(gap)} pts behind today's leader (${leaderName})`);
      }
    }

    // Lens 2: Today's PPG vs own history
    if (todayGP > 0 && ppg && ppg > 0) {
      const todayPPG = todayDayPts / todayGP;
      const pctVsSeason = Math.round(((todayPPG - ppg) / ppg) * 100);
      if (pctVsSeason >= 25) {
        fallbacks.push(`${todayPPG.toFixed(2)} PPG today — ${pctVsSeason}% above season avg`);
      } else if (pctVsSeason <= -25) {
        fallbacks.push(`${todayPPG.toFixed(2)} PPG today — ${Math.abs(pctVsSeason)}% below season avg`);
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
        } else if (currentPeriodRank >= periodSorted.length - 1) {
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

    // (Lens 5 and 6 — historical period comparisons — moved to main impact scoring)

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
  // DEPRECATED — kept for backward compat but use computeCompletedPeriodTotals instead
  const periodDays = allDays.filter(d => d.period === periodNumber);
  if (periodDays.length < 7) return [];
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
 * Compute per-team totals for all COMPLETED periods (excluding current).
 * Returns array of totals — one per team per completed period.
 */
function computeCompletedPeriodTotals(allDays, currentPeriod) {
  // Find all periods that appear in the data, excluding current
  const completedPeriods = [...new Set(allDays.map(d => d.period))].filter(p => p < currentPeriod);
  if (completedPeriods.length === 0) return [];

  const totals = [];
  for (const p of completedPeriods) {
    const periodDays = allDays.filter(d => d.period === p);
    const teamTotals = {};
    for (const day of periodDays) {
      for (const t of day.teams) {
        if (!teamTotals[t.franchise]) teamTotals[t.franchise] = 0;
        teamTotals[t.franchise] += t.dayPts || 0;
      }
    }
    totals.push(...Object.values(teamTotals).filter(v => v > 0));
  }
  return totals;
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
async function buildNightlyAnalysis(todayScrape) {
  const allDays = loadAllDailyScores();
  const period = todayScrape.period;
  const today = todayScrape.date || new Date().toISOString().split("T")[0];

  // Build stats for each team
  const teamStats = await Promise.all(todayScrape.teams.map(async t => {
    const franchise = toFranchise(t.franchise) || toFranchise(t.name) || t.franchise || t.name;

    const avg3d = rollingAvgPPG(allDays, franchise, 3);
    const avg7d = rollingAvgPPG(allDays, franchise, 7);
    const ppg = seasonPPG(allDays, franchise);
    const projection = projectPeriodFinish(allDays, franchise, period);
    const vsProj = t.projPts ? +((t.dayPts || 0) - t.projPts).toFixed(2) : null;

    // Build rich narratives (picks best 1-2 automatically)
    const streaks = await buildNarratives(allDays, franchise, period, t.dayPts || 0, t.gp || 0, projection, avg3d, ppg, todayScrape.teams);

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
  }));

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
