// ============================================================
// SCOREBOARD IMAGE GENERATOR v6 — 4-Column Card Strips
// ============================================================
// 4 stats: DAY, SEASON, PPG, VS PROJ
// 3D/7D trending info moves to the narrative bar.
// Bigger fonts, logos, and team names for inline Slack readability.
// ============================================================

let createCanvas, loadImage, registerFont;
try {
  const canvasModule = require("canvas");
  createCanvas = canvasModule.createCanvas;
  loadImage = canvasModule.loadImage;
  registerFont = canvasModule.registerFont;
} catch (e) {
  createCanvas = null;
  loadImage = null;
}

const fs = require("fs");
const path = require("path");
const { FRANCHISE_NAMES } = require("./config");

const LOGOS_DIR = path.join(__dirname, "..", "data", "logos");

// Neon outline podium colors
const PODIUM = {
  1: {
    color: "#FFD000",
    glow: "rgba(255,208,0,0.45)",
    glowFar: "rgba(255,208,0,0.15)",
    badgeBg: ["#FFF8C0", "#FFD000"],
    badgeText: "#5A3A00",
    nameColor: "#B8860B",
    logoGlow: "rgba(255,208,0,0.35)",
    narrativeTint: "rgba(255,208,0,0.06)",
  },
  2: {
    color: "#B44DFF",
    glow: "rgba(180,77,255,0.40)",
    glowFar: "rgba(180,77,255,0.12)",
    badgeBg: ["#E0B0FF", "#B44DFF"],
    badgeText: "#ffffff",
    nameColor: "#7B2FBE",
    logoGlow: "rgba(180,77,255,0.30)",
    narrativeTint: "rgba(180,77,255,0.05)",
  },
  3: {
    color: "#00D4FF",
    glow: "rgba(0,212,255,0.40)",
    glowFar: "rgba(0,212,255,0.12)",
    badgeBg: ["#B0F0FF", "#00D4FF"],
    badgeText: "#003844",
    nameColor: "#0090AA",
    logoGlow: "rgba(0,212,255,0.30)",
    narrativeTint: "rgba(0,212,255,0.05)",
  },
};

// Clean light theme
const T = {
  cardBg: "#FFFFFF",
  cardBorder: "#E2E4E8",
  rankOther: "#A0A4AB",
  teamName: "#2C3E50",
  colLabel: "#8E95A0",
  colValue: "#4A5568",
  dayValue: "#1A202C",
  positive: "#16A34A",
  negative: "#DC2626",
  neutral: "#9CA3AF",
  narrativeText: "#8E95A0",
  narrativeBorder: "#EDF0F3",
};

// Card strip layout — 2x resolution for crisp text
const CARD_W = 1280;
const CARD_PAD = 24;
const DATA_ROW_H = 124;
const NARRATIVE_H = 80;  // room for 2 lines of narrative
const CARD_RADIUS = 20;
const LOGO_SIZE = 96;
const BADGE_SIZE = 64;
const ELEM_GAP = 20;
const GLOW_PAD = 28;

// 4 columns — more breathing room
const COLS = {
  day:    { x: CARD_W - CARD_PAD - 460 },
  season: { x: CARD_W - CARD_PAD - 328 },
  ppg:    { x: CARD_W - CARD_PAD - 196 },
  vsProj: { x: CARD_W - CARD_PAD - 76 },
};

function vsProjPct(team) {
  const proj = team.projPts || 0;
  const day = team.dayPts || 0;
  if (proj <= 0) return null;
  return Math.round((day / proj) * 100);
}

/**
 * Preload team logo images from data/logos/.
 */
async function preloadLogos(franchises) {
  const logos = {};
  if (!loadImage) return logos;

  for (const abbr of franchises) {
    for (const ext of [".jpg", ".png", ".jpeg"]) {
      const filepath = path.join(LOGOS_DIR, `${abbr}${ext}`);
      if (fs.existsSync(filepath)) {
        try {
          logos[abbr] = await loadImage(filepath);
          break;
        } catch (e) {
          console.log(`[scoreboard] Warning: could not load logo for ${abbr}: ${e.message}`);
        }
      }
    }
  }

  return logos;
}

/**
 * Render a single card strip onto a canvas context.
 */
function renderCardStrip(ctx, team, logos, x, y, w) {
  const rank = team.dayRank;
  const isPodium = rank <= 3;
  const p = PODIUM[rank];
  const cardH = DATA_ROW_H + NARRATIVE_H;

  // White fill
  drawRoundedRect(ctx, x, y, w, cardH, CARD_RADIUS, T.cardBg);

  if (isPodium) {
    ctx.save();
    ctx.shadowColor = p.glow;
    ctx.shadowBlur = 24;
    drawRoundedRect(ctx, x, y, w, cardH, CARD_RADIUS, null);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.shadowColor = p.glowFar;
    ctx.shadowBlur = 40;
    ctx.stroke();
    ctx.restore();
  } else {
    drawRoundedRect(ctx, x, y, w, cardH, CARD_RADIUS, null);
    ctx.strokeStyle = T.cardBorder;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ---- Data Row ----
  const rowCenterY = y + DATA_ROW_H / 2;

  // Logo
  const logoX = x + CARD_PAD;
  const logoY = rowCenterY - LOGO_SIZE / 2;
  const logoImg = logos[team.franchise];

  if (logoImg) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, rowCenterY, LOGO_SIZE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(logoImg, logoX, logoY, LOGO_SIZE, LOGO_SIZE);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, rowCenterY, LOGO_SIZE / 2, 0, Math.PI * 2);
    if (isPodium) {
      ctx.save();
      ctx.shadowColor = p.logoGlow;
      ctx.shadowBlur = 16;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  } else {
    // Fallback letter circle
    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, rowCenterY, LOGO_SIZE / 2, 0, Math.PI * 2);
    ctx.fillStyle = isPodium ? `${p.color}18` : `${T.rankOther}22`;
    ctx.fill();
    ctx.strokeStyle = isPodium ? p.color : `${T.rankOther}44`;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = isPodium ? p.color : T.rankOther;
    ctx.font = "bold 32px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(team.franchise.charAt(0), logoX + LOGO_SIZE / 2, rowCenterY + 12);
  }

  // Rank badge
  const badgeX = logoX + LOGO_SIZE + ELEM_GAP;
  const badgeY = rowCenterY - BADGE_SIZE / 2;

  if (isPodium) {
    const badgeGrad = ctx.createLinearGradient(badgeX, badgeY, badgeX + BADGE_SIZE, badgeY + BADGE_SIZE);
    badgeGrad.addColorStop(0, p.badgeBg[0]);
    badgeGrad.addColorStop(1, p.badgeBg[1]);
    ctx.save();
    ctx.shadowColor = p.glow;
    ctx.shadowBlur = 16;
    drawRoundedRect(ctx, badgeX, badgeY, BADGE_SIZE, BADGE_SIZE, 14, null);
    ctx.fillStyle = badgeGrad;
    ctx.fill();
    ctx.restore();
  } else {
    drawRoundedRect(ctx, badgeX, badgeY, BADGE_SIZE, BADGE_SIZE, 14, T.rankOther);
  }

  ctx.fillStyle = isPodium ? p.badgeText : "#fff";
  ctx.font = "bold 34px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(rank), badgeX + BADGE_SIZE / 2, badgeY + BADGE_SIZE / 2 + 12);

  // Team name
  const nameX = badgeX + BADGE_SIZE + 24;
  const nameMaxW = COLS.day.x - nameX - 28;
  ctx.fillStyle = isPodium ? p.nameColor : T.teamName;
  ctx.font = `${isPodium ? "bold" : "600"} 32px 'Helvetica Neue', Helvetica, Arial, sans-serif`;
  ctx.textAlign = "left";
  const displayName = FRANCHISE_NAMES[team.franchise] || team.name || team.franchise;
  truncateText(ctx, displayName, nameX, rowCenterY + 12, nameMaxW);

  // ---- 4 Column Values ----
  ctx.textAlign = "center";

  // DAY — hero number
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("DAY", COLS.day.x, rowCenterY - 24);
  ctx.fillStyle = T.dayValue;
  ctx.font = "bold 48px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(String(Math.round(team.dayPts || 0)), COLS.day.x, rowCenterY + 28);

  // PERIOD
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("PERIOD", COLS.season.x, rowCenterY - 24);
  ctx.fillStyle = T.colValue;
  ctx.font = "600 34px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(fmtNum(team.periodPts), COLS.season.x, rowCenterY + 28);

  // PPG
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("PPG", COLS.ppg.x, rowCenterY - 24);
  ctx.fillStyle = T.colValue;
  ctx.font = "600 34px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(team.ppg != null ? team.ppg.toFixed(2) : "-", COLS.ppg.x, rowCenterY + 28);

  // VS PROJ (percentage)
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("VS PROJ", COLS.vsProj.x, rowCenterY - 24);
  const pct = vsProjPct(team);
  if (pct != null) {
    ctx.fillStyle = pct >= 100 ? T.positive : T.negative;
    ctx.font = "bold 34px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText(`${pct}%`, COLS.vsProj.x, rowCenterY + 28);
  } else {
    ctx.fillStyle = T.neutral;
    ctx.font = "600 34px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText("-", COLS.vsProj.x, rowCenterY + 28);
  }

  // ---- Narrative Bar (2 lines) ----
  const narY = y + DATA_ROW_H;
  ctx.strokeStyle = isPodium ? `${p.color}30` : T.narrativeBorder;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + 8, narY);
  ctx.lineTo(x + w - 8, narY);
  ctx.stroke();

  if (isPodium) {
    ctx.fillStyle = p.narrativeTint;
    ctx.fillRect(x + 2, narY + 2, w - 4, NARRATIVE_H - 4);
  }

  ctx.textAlign = "left";
  const streaks = team.streaks || [];
  const narX = x + 28;
  const LINE_H = 30;
  const firstLineY = narY + 30;

  if (streaks.length === 0) {
    const projText = team.projection
      ? `Proj finish: ${team.projection.projected} pts`
      : `Season avg: ${(team.ppg || 0).toFixed(2)} PPG`;
    ctx.fillStyle = T.narrativeText;
    ctx.font = "italic 24px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText(projText, narX, firstLineY);
  } else {
    for (let i = 0; i < Math.min(streaks.length, 2); i++) {
      const s = streaks[i];
      const isBad = s.includes("⚠️") || s.includes("📉") || s.includes("⬇️") || s.includes("🏜️");
      ctx.fillStyle = isBad ? T.negative : "#2C3E50";
      ctx.font = `${isBad ? "600" : "500"} 24px 'Helvetica Neue', Helvetica, Arial, sans-serif`;
      ctx.fillText(s, narX, firstLineY + i * LINE_H);
    }
  }

  return cardH;
}

/**
 * Generate individual card strip PNGs for each team.
 * Returns array of { franchise, rank, filepath, name }.
 */
async function generateCardStrips(analysis, options = {}) {
  if (!createCanvas) {
    throw new Error("canvas package not available — skipping scoreboard generation");
  }

  const { teams } = analysis;
  const outputDir = options.outputDir || path.join(__dirname, "..", "cards");

  // Clean out stale cards from previous runs
  if (fs.existsSync(outputDir)) {
    for (const f of fs.readdirSync(outputDir)) {
      if (f.startsWith("card-") && f.endsWith(".png")) {
        fs.unlinkSync(path.join(outputDir, f));
      }
    }
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const franchises = teams.map(t => t.franchise);
  const logos = await preloadLogos(franchises);

  const cardH = DATA_ROW_H + NARRATIVE_H;
  const canvasW = CARD_W + GLOW_PAD * 2;
  const canvasH = cardH + GLOW_PAD * 2;

  const results = [];

  for (const team of teams) {
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvasW, canvasH);

    renderCardStrip(ctx, team, logos, GLOW_PAD, GLOW_PAD, CARD_W);

    const filepath = path.join(outputDir, `card-${team.dayRank}-${team.franchise}.png`);
    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(filepath, buffer);
    console.log(`[scoreboard] Card ${team.dayRank}: ${team.franchise} → ${filepath} (${canvasW}x${canvasH})`);

    results.push({
      franchise: team.franchise,
      rank: team.dayRank,
      filepath,
      name: team.name,
    });
  }

  return results;
}

/**
 * Legacy: generate a single combined scoreboard image.
 */
async function generateScoreboard(analysis, options = {}) {
  if (!createCanvas) {
    throw new Error("canvas package not available — skipping scoreboard generation");
  }

  const { teams, period, date, seasonRanked } = analysis;
  const outputPath = options.outputPath || path.join(__dirname, "..", "scoreboard.png");

  const franchises = teams.map(t => t.franchise);
  const logos = await preloadLogos(franchises);

  const cardH = DATA_ROW_H + NARRATIVE_H;
  const PADDING = 32;
  const HEADER_H = 100;
  const FOOTER_H = 60;
  const GAP = 12;
  const totalH = PADDING + HEADER_H + (cardH + GAP) * teams.length + FOOTER_H + PADDING;

  const canvas = createCanvas(CARD_W, totalH);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#F4F5F7";
  ctx.fillRect(0, 0, CARD_W, totalH);

  // Header
  const hx = PADDING;
  const hy = PADDING;
  drawRoundedRect(ctx, hx, hy, CARD_W - PADDING * 2, HEADER_H, 16, "#FFFFFF");
  ctx.strokeStyle = T.cardBorder;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#E65100";
  ctx.fillRect(hx, hy, 6, HEADER_H);

  const dateStr = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" });
  ctx.fillStyle = T.dayValue;
  ctx.font = "bold 32px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`P${period}: ${dateStr} — Nightly Recap`, hx + 28, hy + 44);
  ctx.fillStyle = T.neutral;
  ctx.font = "22px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("Sparky League • 2025-26", hx + 28, hy + 80);

  let cardY = hy + HEADER_H + 8;
  for (const team of teams) {
    renderCardStrip(ctx, team, logos, PADDING, cardY, CARD_W - PADDING * 2);
    cardY += cardH + GAP;
  }

  // Footer
  ctx.fillStyle = T.neutral;
  ctx.font = "20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("SparkyBot", PADDING, cardY + 28);
  ctx.textAlign = "right";
  if (seasonRanked && seasonRanked.length >= 2) {
    const first = seasonRanked[0];
    const last = seasonRanked[seasonRanked.length - 1];
    const gap = (first.seasonPts - last.seasonPts).toFixed(1);
    ctx.fillText(
      `Season: ${first.franchise} ${first.seasonPts.toFixed(1)} — ${last.franchise} ${last.seasonPts.toFixed(1)} (${gap} pt gap)`,
      CARD_W - PADDING, cardY + 28
    );
  }

  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(outputPath, buffer);
  console.log(`[scoreboard] Combined image saved: ${outputPath} (${CARD_W}x${totalH})`);
  return outputPath;
}

// ---- Drawing Helpers ----

function drawRoundedRect(ctx, x, y, w, h, r, fill, stroke) {
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
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function truncateText(ctx, text, x, y, maxW) {
  if (ctx.measureText(text).width <= maxW) {
    ctx.fillText(text, x, y);
    return;
  }
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(truncated + "…").width > maxW) {
    truncated = truncated.slice(0, -1);
  }
  ctx.fillText(truncated + "…", x, y);
}

function fmtNum(n) {
  if (n == null) return "-";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

module.exports = { generateCardStrips, generateScoreboard };
