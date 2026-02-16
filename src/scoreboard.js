// ============================================================
// SCOREBOARD IMAGE GENERATOR
// ============================================================
// Generates a scoreboard PNG matching the Fantrax card layout.
// Uses node-canvas for server-side image rendering.
// ============================================================

let createCanvas, loadImage;
try {
  const canvasModule = require("canvas");
  createCanvas = canvasModule.createCanvas;
  loadImage = canvasModule.loadImage;
} catch (e) {
  // canvas not available (e.g. Windows local dev)
  createCanvas = null;
  loadImage = null;
}
const fs = require("fs");
const path = require("path");

const LOGOS_DIR = path.join(__dirname, "..", "data", "logos");

// Card dimensions
const CARD_WIDTH = 480;
const CARD_HEIGHT = 100;
const CARD_GAP = 8;
const CARD_RADIUS = 12;
const PADDING = 16;
const LOGO_SIZE = 56;

// Colors
const COLORS = {
  background: "#1a1a2e",     // dark navy
  cardBg: "#16213e",         // slightly lighter navy
  cardBorder: "#0f3460",     // blue border
  rank: "#e94560",           // red/coral for rank number
  teamName: "#ffffff",       // white
  seasonLabel: "#8a8a9a",    // muted gray
  seasonValue: "#ffffff",    // white
  periodLabel: "#e94560",    // red for period label
  periodValue: "#4ecca3",    // green for period score
  periodZero: "#8a8a9a",    // gray when period is 0
  subtext: "#6a6a7a",        // muted for roster info
  positive: "#4ecca3",       // green for gains
  negative: "#e94560",       // red for losses
  divider: "#2a2a4a"         // subtle divider
};

// Rank colors (1st gets gold, etc.)
const RANK_COLORS = {
  1: "#FFD700",  // gold
  2: "#C0C0C0",  // silver
  3: "#CD7F32",  // bronze
  4: "#8a8a9a",
  5: "#8a8a9a",
  6: "#8a8a9a"
};

/**
 * Generate a scoreboard image from scraped data.
 *
 * @param {object} context - Output from analyze.buildContext()
 * @param {object} options - { outputPath, title }
 * @returns {string} Path to the generated PNG
 */
async function generateScoreboard(context, options = {}) {
  if (!createCanvas) {
    throw new Error("canvas package not available — skipping scoreboard generation");
  }

  const { standings, period, scrapedAt, changes } = context;
  const outputPath = options.outputPath || path.join(__dirname, "..", "scoreboard.png");
  const title = options.title || `Period ${period} — Live Standings`;

  const teamCount = standings.length;
  const headerHeight = 50;
  const footerHeight = 30;
  const canvasHeight = headerHeight + (CARD_HEIGHT + CARD_GAP) * teamCount + footerHeight + PADDING * 2;
  const canvasWidth = CARD_WIDTH + PADDING * 2;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Header
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(title, PADDING, PADDING + 24);

  // Timestamp
  const timeStr = new Date(scrapedAt).toLocaleString("en-US", {
    timeZone: "America/Vancouver",
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
    hour12: true
  });
  ctx.fillStyle = COLORS.subtext;
  ctx.font = "12px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(timeStr, canvasWidth - PADDING, PADDING + 24);
  ctx.textAlign = "left";

  // Draw each team card
  for (let i = 0; i < teamCount; i++) {
    const team = standings[i];
    const rank = i + 1;
    const cardX = PADDING;
    const cardY = headerHeight + PADDING + (CARD_HEIGHT + CARD_GAP) * i;

    // Card background with rounded corners
    drawRoundedRect(ctx, cardX, cardY, CARD_WIDTH, CARD_HEIGHT, CARD_RADIUS, COLORS.cardBg, COLORS.cardBorder);

    // Try to load team logo
    let logoLoaded = false;
    const logoPath = path.join(LOGOS_DIR, `${team.franchise}.png`);
    const logoPathJpg = path.join(LOGOS_DIR, `${team.franchise}.jpg`);

    try {
      let logoFile = fs.existsSync(logoPath) ? logoPath : fs.existsSync(logoPathJpg) ? logoPathJpg : null;
      if (logoFile) {
        const logo = await loadImage(logoFile);
        // Clip to circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(cardX + PADDING + LOGO_SIZE / 2, cardY + CARD_HEIGHT / 2, LOGO_SIZE / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(logo, cardX + PADDING, cardY + (CARD_HEIGHT - LOGO_SIZE) / 2, LOGO_SIZE, LOGO_SIZE);
        ctx.restore();
        logoLoaded = true;
      }
    } catch (e) {
      // Logo failed to load — fall through to badge
    }

    const textStartX = cardX + PADDING + (logoLoaded ? LOGO_SIZE + 12 : 0);

    // Rank badge (if no logo, show rank as large number)
    if (!logoLoaded) {
      ctx.fillStyle = RANK_COLORS[rank] || COLORS.subtext;
      ctx.font = "bold 36px 'Helvetica Neue', Helvetica, Arial, sans-serif";
      ctx.fillText(String(rank), cardX + PADDING + 8, cardY + CARD_HEIGHT / 2 + 12);
    } else {
      // Small rank number overlaid
      ctx.fillStyle = RANK_COLORS[rank] || COLORS.subtext;
      ctx.font = "bold 18px 'Helvetica Neue', Helvetica, Arial, sans-serif";
      ctx.fillText(String(rank), cardX + PADDING - 2, cardY + 18);
    }

    // Team name
    ctx.fillStyle = COLORS.teamName;
    ctx.font = "bold 16px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    const displayName = team.name || team.franchise;
    const maxNameWidth = CARD_WIDTH - (textStartX - cardX) - 130;
    const truncatedName = truncateText(ctx, displayName, maxNameWidth);
    ctx.fillText(truncatedName, textStartX, cardY + 32);

    // Season score
    const seasonX = cardX + CARD_WIDTH - 120;
    ctx.fillStyle = COLORS.seasonLabel;
    ctx.font = "10px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText("Season", seasonX, cardY + 18);

    ctx.fillStyle = COLORS.seasonValue;
    ctx.font = "bold 24px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText(String(team.seasonPts), seasonX, cardY + 44);

    // Period/Day score
    const periodX = cardX + CARD_WIDTH - 40;
    ctx.fillStyle = COLORS.periodLabel;
    ctx.font = "10px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("Day", periodX + 14, cardY + 18);

    const dayPts = team.dayPts || 0;
    ctx.fillStyle = dayPts > 0 ? COLORS.periodValue : COLORS.periodZero;
    ctx.font = "bold 24px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText(String(dayPts), periodX + 14, cardY + 44);
    ctx.textAlign = "left";

    // Change indicator (if we have comparison data)
    if (changes && changes.movements) {
      const movement = changes.movements.find(m => m.franchise === team.franchise);
      if (movement && movement.ptsDiff !== 0) {
        const changeStr = movement.ptsDiff > 0 ? `+${movement.ptsDiff}` : String(movement.ptsDiff);
        ctx.fillStyle = movement.ptsDiff > 0 ? COLORS.positive : COLORS.negative;
        ctx.font = "bold 11px 'Helvetica Neue', Helvetica, Arial, sans-serif";
        ctx.fillText(changeStr, seasonX, cardY + 62);
      }

      if (movement && movement.rankChange !== 0) {
        const arrow = movement.rankChange > 0 ? "▲" : "▼";
        ctx.fillStyle = movement.rankChange > 0 ? COLORS.positive : COLORS.negative;
        ctx.font = "10px 'Helvetica Neue', Helvetica, Arial, sans-serif";
        ctx.fillText(`${arrow}${Math.abs(movement.rankChange)}`, textStartX, cardY + 50);
      }
    }

    // Projected FP/G (small, bottom of card)
    if (team.projectedFpg && team.projectedFpg > 0) {
      ctx.fillStyle = COLORS.subtext;
      ctx.font = "11px 'Helvetica Neue', Helvetica, Arial, sans-serif";
      ctx.fillText(`Prj: ${team.projectedFpg}`, textStartX, cardY + 68);
    }

    // Gap from 1st (for non-leaders)
    if (rank > 1) {
      const gap = standings[0].seasonPts - team.seasonPts;
      ctx.fillStyle = COLORS.subtext;
      ctx.font = "11px 'Helvetica Neue', Helvetica, Arial, sans-serif";
      ctx.fillText(`-${gap} from 1st`, textStartX + 80, cardY + 68);
    }
  }

  // Footer
  ctx.fillStyle = COLORS.subtext;
  ctx.font = "10px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("Sparky League • SparkyBot", PADDING, canvasHeight - 10);

  // Save
  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(outputPath, buffer);
  console.log(`[scoreboard] Image saved: ${outputPath}`);
  return outputPath;
}

/**
 * Draw a rounded rectangle with fill and optional border.
 */
function drawRoundedRect(ctx, x, y, w, h, r, fillColor, borderColor) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();

  ctx.fillStyle = fillColor;
  ctx.fill();

  if (borderColor) {
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * Truncate text with ellipsis if it exceeds maxWidth.
 */
function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (ctx.measureText(truncated + "…").width > maxWidth && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "…";
}

module.exports = { generateScoreboard };
