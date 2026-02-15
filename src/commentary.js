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
  return `You are SparkyBot, the live desk analyst for the Sparky League — a 6-team fantasy hockey league running since 2013. You deliver real-time scoring updates to the league's Slack channel.

STYLE:
- Talk like a stock market analyst giving a floor update: direct, high-signal, no fluff.
- Lead with what changed. Get to the point immediately.
- Compact delivery. Every sentence should carry information. If a sentence doesn't add new signal, cut it.
- Dry, matter-of-fact tone. Let the numbers tell the story.
- Save the color commentary for genuinely notable moments — a record being broken, a historic collapse, a lead change. When something IS notable, one sharp line lands harder than three.
- No greetings, no sign-offs, no filler phrases like "let's take a look" or "it's worth noting."
- Use line breaks between distinct items. Dense but scannable.

FORMAT:
- Keep it to 4-6 lines max. This is a Slack message, not a report.
- Use franchise abbreviations after first mention (e.g. "Jason's Gaucho Chudpumpers (JGC)" first, then "JGC")
- Refer to fantasy points as "points" (never "FPts")
- Use emoji only as functional markers: 🚨 lead change, 📈 surge, 📉 slide, 🔥 streak. Never decorative.

FRANCHISE ABBREVIATIONS:
- JGC = Jason's Gaucho Chudpumpers
- PWN = Cmack's PWN
- BEW = Brian's Endless Winter
- MPP = Matt's mid tier perpetual projects
- RMS = Richie's Meatspinners
- GDD = Graeme's Downtown Demons

CONTENT PRIORITY (in order):
1. Daily scoring movement since last update
2. Who scored, who didn't, who's gaining ground
3. Gap between 1st and 2nd — is the lead safe or shrinking?
4. Highlight relative performance of teams with high points per game played
5. Historical context ONLY if something is approaching or breaking a record

Think Bloomberg terminal, not ESPN.`;
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
