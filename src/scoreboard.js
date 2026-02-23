// ============================================================
// SCOREBOARD IMAGE GENERATOR v5 — Card Strips
// ============================================================
// Generates one PNG per team (640px wide, ~90px tall).
// Designed for inline Slack display without thumbnailing.
// White cards with neon outline borders + glow on podium.
// Day score as whole number. VS Proj as percentage.
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
    accent: "rgba(255,208,0,0.10)",
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
    accent: "rgba(180,77,255,0.08)",
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
    accent: "rgba(0,212,255,0.08)",
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
  narrativeHighlight: "#E65100",
  narrativeBorder: "#EDF0F3",
};

// Card strip layout
const CARD_W = 640;
const CARD_PAD = 10;
const DATA_ROW_H = 56;
const NARRATIVE_H = 24;
const CARD_RADIUS = 10;
const LOGO_SIZE = 40;
const BADGE_SIZE = 30;
const ELEM_GAP = 10;
const GLOW_PAD = 14; // extra padding for glow to not get clipped

// Column positions (right-aligned, with breathing room on right edge)
const COLS = {
  day:    { x: CARD_W - CARD_PAD - 296 },
  season: { x: CARD_W - CARD_PAD - 244 },
  ppg:    { x: CARD_W - CARD_PAD - 192 },
  avg3:   { x: CARD_W - CARD_PAD - 144 },
  avg7:   { x: CARD_W - CARD_PAD - 96 },
  vsProj: { x: CARD_W - CARD_PAD - 40 },
};

function getTrendColor(avg, seasonPpg) {
  if (avg === null || seasonPpg === null) return T.neutral;
  if (avg > seasonPpg + 0.05) return T.positive;
  if (avg < seasonPpg - 0.05) return T.negative;
  return T.neutral;
}

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
 * Generate a single card strip PNG for one team.
 */
function renderCardStrip(ctx, team, logos, x, y, w) {
  const rank = team.dayRank;
  const isPodium = rank <= 3;
  const p = PODIUM[rank];
  const cardH = DATA_ROW_H + NARRATIVE_H;

  // ---- Card background (white fill) ----
  drawRoundedRect(ctx, x, y, w, cardH, CARD_RADIUS, T.cardBg);

  if (isPodium) {
    // Neon border with glow
    ctx.save();
    ctx.shadowColor = p.glow;
    ctx.shadowBlur = 12;
    drawRoundedRect(ctx, x, y, w, cardH, CARD_RADIUS, null);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowColor = p.glowFar;
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.restore();
  } else {
    drawRoundedRect(ctx, x, y, w, cardH, CARD_RADIUS, null);
    ctx.strokeStyle = T.cardBorder;
    ctx.lineWidth = 1;
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
      ctx.shadowBlur = 8;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  } else {
    // Fallback letter circle
    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, rowCenterY, LOGO_SIZE / 2, 0, Math.PI * 2);
    ctx.fillStyle = isPodium ? p.accent : `${T.rankOther}22`;
    ctx.fill();
    ctx.strokeStyle = isPodium ? p.color : `${T.rankOther}44`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = isPodium ? p.color : T.rankOther;
    ctx.font = "bold 14px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(team.franchise.charAt(0), logoX + LOGO_SIZE / 2, rowCenterY + 5);
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
    ctx.shadowBlur = 8;
    drawRoundedRect(ctx, badgeX, badgeY, BADGE_SIZE, BADGE_SIZE, 6, null);
    ctx.fillStyle = badgeGrad;
    ctx.fill();
    ctx.restore();
  } else {
    drawRoundedRect(ctx, badgeX, badgeY, BADGE_SIZE, BADGE_SIZE, 6, T.rankOther);
  }

  ctx.fillStyle = isPodium ? p.badgeText : "#fff";
  ctx.font = "bold 15px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(rank), badgeX + BADGE_SIZE / 2, badgeY + BADGE_SIZE / 2 + 5);

  // Team name
  const nameX = badgeX + BADGE_SIZE + 10;
  const nameMaxW = COLS.day.x - nameX - 10;
  ctx.fillStyle = isPodium ? p.nameColor : T.teamName;
  ctx.font = `${isPodium ? "bold" : "600"} 14px 'Helvetica Neue', Helvetica, Arial, sans-serif`;
  ctx.textAlign = "left";
  truncateText(ctx, team.name, nameX, rowCenterY + 5, nameMaxW);

  // ---- Column values with labels ----
  ctx.textAlign = "center";

  // Day
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 9px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("DAY", COLS.day.x, rowCenterY - 10);
  ctx.fillStyle = T.dayValue;
  ctx.font = "bold 20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(String(Math.round(team.dayPts || 0)), COLS.day.x, rowCenterY + 12);

  // Season
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 9px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("SEASON", COLS.season.x, rowCenterY - 10);
  ctx.fillStyle = T.colValue;
  ctx.font = "600 15px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(fmtNum(team.seasonPts), COLS.season.x, rowCenterY + 12);

  // PPG
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 9px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("PPG", COLS.ppg.x, rowCenterY - 10);
  ctx.fillStyle = T.colValue;
  ctx.font = "500 13px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(team.ppg != null ? team.ppg.toFixed(2) : "-", COLS.ppg.x, rowCenterY + 12);

  // 3D
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 9px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("3D", COLS.avg3.x, rowCenterY - 10);
  ctx.fillStyle = getTrendColor(team.avg3d, team.ppg);
  ctx.font = "600 13px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(team.avg3d != null ? team.avg3d.toFixed(2) : "-", COLS.avg3.x, rowCenterY + 12);

  // 7D
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 9px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("7D", COLS.avg7.x, rowCenterY - 10);
  ctx.fillStyle = getTrendColor(team.avg7d, team.ppg);
  ctx.font = "600 13px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText(team.avg7d != null ? team.avg7d.toFixed(2) : "-", COLS.avg7.x, rowCenterY + 12);

  // VS Proj (percentage)
  ctx.fillStyle = T.colLabel;
  ctx.font = "bold 9px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("VS PROJ", COLS.vsProj.x, rowCenterY - 10);
  const pct = vsProjPct(team);
  if (pct != null) {
    ctx.fillStyle = pct >= 100 ? T.positive : T.negative;
    ctx.font = "bold 15px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText(`${pct}%`, COLS.vsProj.x, rowCenterY + 12);
  } else {
    ctx.fillStyle = T.neutral;
    ctx.font = "500 13px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText("-", COLS.vsProj.x, rowCenterY + 12);
  }

  // ---- Narrative Bar ----
  const narY = y + DATA_ROW_H;
  ctx.strokeStyle = isPodium ? `${p.color}30` : T.narrativeBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 4, narY);
  ctx.lineTo(x + w - 4, narY);
  ctx.stroke();

  if (isPodium) {
    ctx.fillStyle = p.narrativeTint;
    ctx.fillRect(x + 1, narY + 1, w - 2, NARRATIVE_H - 2);
  }

  ctx.textAlign = "left";
  const streaks = team.streaks || [];
  let narX = x + 12;

  if (streaks.length === 0) {
    // Fallback: show projection
    const projText = team.projection
      ? `Proj finish: ${team.projection.projected} pts`
      : `Season avg: ${(team.ppg || 0).toFixed(2)} PPG`;
    ctx.fillStyle = T.narrativeText;
    ctx.font = "italic 11px 'Helvetica Neue', Helvetica, Arial, sans-serif";
    ctx.fillText(projText, narX, narY + 15);
  } else {
    for (const s of streaks) {
      const isHot = s.includes("🔥") || s.includes("📈") || s.includes("⭐");
      const isCold = s.includes("📉") || s.includes("⚠️");
      ctx.fillStyle = isHot ? (isPodium ? p.nameColor : T.narrativeHighlight) :
                      isCold ? T.negative : T.narrativeText;
      ctx.font = `${isHot ? "600" : "400"} 11px 'Helvetica Neue', Helvetica, Arial, sans-serif`;
      ctx.fillText(s, narX, narY + 15);
      narX += ctx.measureText(s).width + 14;
    }
  }

  return cardH;
}

/**
 * Generate individual card strip PNGs for each team.
 * Returns array of { franchise, filepath } objects.
 */
async function generateCardStrips(analysis, options = {}) {
  if (!createCanvas) {
    throw new Error("canvas package not available — skipping scoreboard generation");
  }

  const { teams } = analysis;
  const outputDir = options.outputDir || path.join(__dirname, "..", "cards");

  if (!fs.existsSync(outputDir)) {
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

    // Transparent background — card floats
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
 * Still available if needed.
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
  const PADDING = 16;
  const HEADER_H = 50;
  const FOOTER_H = 30;
  const GAP = 6;
  const totalH = PADDING + HEADER_H + (cardH + GAP) * teams.length + FOOTER_H + PADDING;

  const canvas = createCanvas(CARD_W, totalH);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#F4F5F7";
  ctx.fillRect(0, 0, CARD_W, totalH);

  // Header
  const hx = PADDING;
  const hy = PADDING;
  drawRoundedRect(ctx, hx, hy, CARD_W - PADDING * 2, HEADER_H, 8, "#FFFFFF");
  ctx.strokeStyle = T.cardBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#E65100";
  ctx.fillRect(hx, hy, 3, HEADER_H);

  const dateStr = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" });
  ctx.fillStyle = T.dayValue;
  ctx.font = "bold 16px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`P${period}: ${dateStr} — Nightly Recap`, hx + 14, hy + 22);
  ctx.fillStyle = T.neutral;
  ctx.font = "11px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.fillText("Sparky League • 2025-26", hx + 14, hy + 40);

  // Cards
  let cardY = hy + HEADER_H + 8;
  for (const team of teams) {
    renderCardStrip(ctx, team, logos, PADDING, cardY, CARD_W - PADDING * 2);
    cardY += cardH + GAP;
  }

  // Footer
  ctx.fillStyle = T.neutral;
  ctx.font = "10px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("SparkyBot", PADDING, cardY + 14);
  ctx.textAlign = "right";
  if (seasonRanked && seasonRanked.length >= 2) {
    const first = seasonRanked[0];
    const last = seasonRanked[seasonRanked.length - 1];
    const gap = (first.seasonPts - last.seasonPts).toFixed(1);
    ctx.fillText(
      `Season: ${first.franchise} ${first.seasonPts.toFixed(1)} — ${last.franchise} ${last.seasonPts.toFixed(1)} (${gap} pt gap)`,
      CARD_W - PADDING, cardY + 14
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
