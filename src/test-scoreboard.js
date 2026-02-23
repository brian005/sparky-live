// ============================================================
// TEST SCOREBOARD — Card strips + combined image
// ============================================================
// Usage: node src/test-scoreboard.js
// Output: cards/ directory + scoreboard.png
// ============================================================

const path = require("path");
const { generateCardStrips, generateScoreboard } = require("./scoreboard");

const mockAnalysis = {
  date: "2026-02-23",
  period: 10,
  scrapedAt: new Date().toISOString(),
  periodDaysPlayed: 14,
  totalSeasonDays: 126,

  teams: [
    {
      franchise: "JGC", name: "Gaucho Chudpumpers",
      dayPts: 11, projPts: 8, seasonPts: 771, ppg: 0.92, avg3d: 1.14, avg7d: 1.02,
      dayRank: 1, seasonRank: 1,
      streaks: ["🔥 3-day win streak", "📈 3D avg 1.14 (up from 0.92 season)"],
      projection: { projected: 842 },
    },
    {
      franchise: "MPP", name: "mid tier perpetual projects",
      dayPts: 8, projPts: 7, seasonPts: 754, ppg: 0.94, avg3d: 0.98, avg7d: 0.95,
      dayRank: 2, seasonRank: 2,
      streaks: ["📈 7-day podium streak"],
      projection: { projected: 821 },
    },
    {
      franchise: "RMS", name: "Meatspinners",
      dayPts: 5, projPts: 6, seasonPts: 691, ppg: 0.87, avg3d: 0.91, avg7d: 0.85,
      dayRank: 3, seasonRank: 5,
      streaks: ["⚠️ 12-day bottom-half streak", "📉 3D avg 0.65 — slumping (-25% below season)"],
      projection: { projected: 752 },
    },
    {
      franchise: "GDD", name: "Downtown Demons",
      dayPts: 5, projPts: 6, seasonPts: 753, ppg: 0.93, avg3d: 0.88, avg7d: 0.91,
      dayRank: 4, seasonRank: 3,
      streaks: ["📉 3D avg 0.88 (down from 0.93 season)"],
      projection: { projected: 819 },
    },
    {
      franchise: "BEW", name: "Endless Winter",
      dayPts: 4, projPts: 4, seasonPts: 674, ppg: 0.82, avg3d: 0.84, avg7d: 0.80,
      dayRank: 5, seasonRank: 6,
      streaks: ["⭐ Best day this period"],
      projection: { projected: 735 },
    },
    {
      franchise: "PWN", name: "PWN",
      dayPts: 4, projPts: 4, seasonPts: 697, ppg: 0.84, avg3d: 0.79, avg7d: 0.82,
      dayRank: 6, seasonRank: 4,
      streaks: ["Proj finish: 758 pts"],
      projection: { projected: 758 },
    },
  ],

  seasonRanked: null,
};

mockAnalysis.seasonRanked = [...mockAnalysis.teams]
  .sort((a, b) => b.seasonPts - a.seasonPts)
  .map((t, i) => ({ ...t, seasonRank: i + 1 }));

async function main() {
  console.log("🎨 Generating card strips...\n");

  try {
    const cardsDir = path.join(__dirname, "..", "cards");
    const cards = await generateCardStrips(mockAnalysis, { outputDir: cardsDir });
    console.log(`\n✅ ${cards.length} card strips saved to: ${cardsDir}\n`);

    console.log("🎨 Generating combined scoreboard...\n");
    const scoreboardPath = path.join(__dirname, "..", "scoreboard.png");
    await generateScoreboard(mockAnalysis, { outputPath: scoreboardPath });
    console.log(`\n✅ Combined scoreboard saved to: ${scoreboardPath}`);
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
