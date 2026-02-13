// ============================================================
// CLAUDE COMMENTARY ENGINE
// ============================================================
// Takes the analysis context and generates game-night
// commentary via the Anthropic API.
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

const FRANCHISE_NAMES = {
  Jason: { full: "Jason's Gaucho Chudpumpers", abbr: "JGC" },
  Chris: { full: "Cmack's PWN", abbr: "PWN" },
  Brian: { full: "Brian's Endless Winter", abbr: "BEW" },
  Matt: { full: "Matt's mid tier perpetual projects", abbr: "MPP" },
  Richie: { full: "Richie's Meatspinners", abbr: "RMS" },
  Graeme: { full: "Graeme's Downtown Demons", abbr: "GDD" }
};

/**
 * Generate commentary for a live scoring update.
 * 
 * @param {object} context - Output from analyze.buildContext()
 * @param {string} apiKey - Anthropic API key
 * @param {string} commentaryType - "update" for mid-period, "nightly" for end-of-night recap
 * @returns {string} Commentary text for Slack
 */
async function generateCommentary(context, apiKey, commentaryType = "update") {
  const client = new Anthropic({ apiKey });

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(context, commentaryType);

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
  return `You are SparkyBot, the official commentator for the Sparky League — a 6-team fantasy hockey league that has been running since 2013. You provide live game-night updates and commentary in the league's Slack channel.

STYLE:
- Witty, fun, a bit trash-talky but never mean-spirited
- Like a sports broadcaster doing color commentary
- Use franchise abbreviations after first mention (e.g. "Jason's Gaucho Chudpumpers (JGC)" first, then "JGC")
- Refer to fantasy points as "points" (never "FPts")
- Keep updates concise — these are Slack messages, not essays. 2-4 short paragraphs max.
- Use emoji sparingly but effectively (🔥 for hot streaks, 📉 for drops, 🚨 for lead changes)

FRANCHISE ABBREVIATIONS:
- JGC = Jason's Gaucho Chudpumpers
- PWN = Cmack's PWN  
- BEW = Brian's Endless Winter
- MPP = Matt's mid tier perpetual projects
- RMS = Richie's Meatspinners
- GDD = Graeme's Downtown Demons

WHAT MAKES GOOD COMMENTARY:
- Lead changes and close races
- Someone going on a run or collapsing
- Historical context ("this would be the 3rd highest P9 score ever")
- Schedule luck angles (lots of GP vs efficient but fewer games)
- Streaks continuing or ending
- When someone's pace would set a record

Keep it fun. The league members should look forward to seeing these updates.`;
}

function buildUserPrompt(context, commentaryType) {
  const { standings, changes, historicalContext, period, scrapedAt } = context;

  let prompt = `Generate a ${commentaryType === "nightly" ? "nightly recap" : "live update"} for the Sparky League.\n\n`;

  // Current standings
  prompt += `CURRENT PERIOD ${period} STANDINGS (as of ${new Date(scrapedAt).toLocaleString("en-US", { timeZone: "America/Vancouver" })}):\n`;
  standings.forEach((t, i) => {
    prompt += `  ${i + 1}. ${t.franchise}: ${t.seasonPts} pts (today: ${t.dayPts > 0 ? "+" + t.dayPts : t.dayPts})\n`;
  });

  const leader = standings[0];
  const last = standings[standings.length - 1];
  prompt += `\n1st-to-last gap: ${leader.seasonPts - last.seasonPts} points\n`;
  if (standings.length >= 2) {
    prompt += `1st-to-2nd gap: ${leader.seasonPts - standings[1].seasonPts} points\n`;
  }

  // Changes since last scrape
  if (changes && changes.movements.length > 0) {
    prompt += `\nCHANGES SINCE LAST UPDATE (${changes.timeSinceLast} ago):\n`;
    for (const m of changes.movements) {
      let line = `  ${m.franchise}: ${m.ptsDiff >= 0 ? "+" : ""}${m.ptsDiff} pts (${m.prevPts} → ${m.newPts})`;
      if (m.rankChange > 0) line += ` ↑ moved up to #${m.currentRank}`;
      else if (m.rankChange < 0) line += ` ↓ dropped to #${m.currentRank}`;
      prompt += line + "\n";
    }

    // Flag lead changes
    const leaderMovement = changes.movements.find(m => m.franchise === leader.franchise);
    if (leaderMovement && leaderMovement.prevRank > 1) {
      prompt += `\n🚨 LEAD CHANGE: ${leader.franchise} has taken the lead!\n`;
    }
  }

  // Historical context
  if (historicalContext) {
    prompt += `\nHISTORICAL CONTEXT:\n`;
    if (historicalContext.samePeriodWinners && historicalContext.samePeriodWinners.length > 0) {
      const sorted = [...historicalContext.samePeriodWinners].sort((a, b) => b.FPts - a.FPts);
      prompt += `  Best ever Period ${period} winning score: ${sorted[0].FPts} by ${sorted[0].franchise} (${sorted[0].season})\n`;
      prompt += `  Worst ever Period ${period} winning score: ${sorted[sorted.length - 1].FPts} by ${sorted[sorted.length - 1].franchise} (${sorted[sorted.length - 1].season})\n`;
    }
    if (historicalContext.leaderFranchiseBest) {
      const lb = historicalContext.leaderFranchiseBest;
      prompt += `  ${leader.franchise}'s all-time best: ${lb.FPts} (${lb.season} P${lb.period})\n`;
      prompt += `  ${leader.franchise}'s average: ${historicalContext.leaderFranchiseAvg}\n`;
    }
  }

  if (commentaryType === "nightly") {
    prompt += `\nThis is the end-of-night recap. Summarize how tonight's games shifted the standings and preview what to watch for tomorrow.`;
  } else {
    prompt += `\nThis is a mid-game update. Focus on what's happening right now — who's scoring, who's moving, what's at stake.`;
  }

  return prompt;
}

module.exports = { generateCommentary };
