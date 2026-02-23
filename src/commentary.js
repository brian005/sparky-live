// ============================================================
// CLAUDE COMMENTARY ENGINE v2
// ============================================================
// Takes nightly analysis and generates Bloomberg-style
// Slack commentary via the Anthropic API.
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

/**
 * Generate nightly recap commentary.
 *
 * @param {object} analysis - Output from analyze.buildNightlyAnalysis()
 * @param {string} apiKey - Anthropic API key
 * @param {string} commentaryType - "nightly" (default) or "update"
 * @returns {string} Commentary text for Slack
 */
async function generateCommentary(analysis, apiKey, commentaryType = "nightly") {
  const client = new Anthropic({ apiKey });

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(analysis, commentaryType);

  console.log("[commentary] Calling Claude API...");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });

  const text = response.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");

  console.log("[commentary] Commentary generated.");
  return text;
}

function buildSystemPrompt() {
  return `You are SparkyBot, the live desk analyst for the Sparky League — a 6-team fantasy hockey league running since 2013. You deliver scoring recaps to the league's Slack channel.

STYLE:
- Talk like a stock market analyst giving a floor update: direct, high-signal, no fluff.
- Lead with what changed. Get to the point immediately.
- Compact delivery. Every sentence should carry information.
- Dry, matter-of-fact tone. Let the numbers tell the story.
- Save color commentary for genuinely notable moments — a record, a historic collapse, a lead change.
- No greetings, no sign-offs, no filler phrases like "let's take a look" or "it's worth noting."
- Use line breaks between distinct items. Dense but scannable.

FORMAT:
- 6-10 lines max. This is a Slack message, not a report.
- Use franchise abbreviations after first mention (e.g. "Jason's Gaucho Chudpumpers (JGC)" first, then "JGC")
- Call fantasy points just "points" — never "FPts"
- Emoji only as functional markers: 🚨 lead change, 📈 surge, 📉 slide, 🔥 streak. Never decorative.

FRANCHISE ABBREVIATIONS:
- JGC = Gaucho Chudpumpers
- PWN = PWN
- BEW = Endless Winter
- MPP = mid tier perpetual projects
- RMS = Meatspinners
- GDD = Downtown Demons

CONTENT PRIORITY:
1. Who won the day and by how much
2. Streaks and momentum — who's hot, who's cold (reference 3D/7D rolling averages)
3. Season standings impact — did today change the rankings?
4. VS Projected: who beat expectations, who underperformed
5. Period projection if notable (on pace for a record, etc.)
6. One sharp closing line if the data warrants it

Think Bloomberg terminal, not ESPN.`;
}

function buildUserPrompt(analysis, commentaryType) {
  const { teams, seasonRanked, period, date, periodDaysPlayed, totalSeasonDays } = analysis;

  let prompt = `Generate a nightly recap for the Sparky League.\n\n`;

  prompt += `DATE: ${date} | PERIOD ${period} (Day ${periodDaysPlayed + 1})\n\n`;

  // Day rankings
  prompt += `TODAY'S SCORING (ranked by day score):\n`;
  for (const t of teams) {
    const vsStr = t.vsProj != null ? ` | VS Proj: ${t.vsProj >= 0 ? "+" : ""}${t.vsProj.toFixed(2)}` : "";
    prompt += `  ${t.dayRank}. ${t.franchise}: ${t.dayPts} pts (${t.gp} GP)${vsStr}\n`;
  }

  prompt += `\nSEASON STANDINGS:\n`;
  if (seasonRanked && seasonRanked.length > 0) {
    for (const t of seasonRanked) {
      prompt += `  ${t.seasonRank}. ${t.franchise}: ${t.seasonPts.toFixed(1)} pts | PPG: ${t.ppg} | 3D: ${t.avg3d} | 7D: ${t.avg7d}\n`;
    }
  }

  // Streaks
  const notableStreaks = teams.filter(t => t.streaks && t.streaks.length > 0 && !t.streaks[0].startsWith("Proj"));
  if (notableStreaks.length > 0) {
    prompt += `\nACTIVE STREAKS:\n`;
    for (const t of notableStreaks) {
      prompt += `  ${t.franchise}: ${t.streaks.join(", ")}\n`;
    }
  }

  // Projections
  const projs = teams.filter(t => t.projection);
  if (projs.length > 0) {
    prompt += `\nPERIOD ${period} PROJECTIONS:\n`;
    for (const t of projs) {
      const p = t.projection;
      prompt += `  ${t.franchise}: ${p.periodPts} actual → proj ${p.projected} (${p.daysRemaining} days left)\n`;
    }
  }

  prompt += `\nDeliver the nightly recap. The scoreboard image is already attached — your job is the narrative.`;

  return prompt;
}

module.exports = { generateCommentary };
