// ============================================================
// SLACK POSTER (with image upload support)
// ============================================================
// Posts commentary text and scoreboard images to Slack.
// Uses Bot Token for file uploads, webhook for text-only.
// ============================================================

const https = require("https");
const fs = require("fs");

/**
 * Post a text message via incoming webhook.
 */
async function postToSlack(webhookUrl, text, options = {}) {
  const payload = {
    text,
    username: options.username || "SparkyBot",
    icon_emoji: options.icon_emoji || ":hockey:"
  };

  return httpPost(webhookUrl, payload);
}

/**
 * Upload an image to a Slack channel using the Bot Token API.
 * Uses files.getUploadURLExternal + files.completeUploadExternal (v2 flow).
 *
 * @param {string} botToken - Slack Bot User OAuth Token (xoxb-...)
 * @param {string} channelId - Slack channel ID (not name)
 * @param {string} filePath - Path to the image file
 * @param {string} title - Title for the uploaded file
 * @param {string} comment - Initial comment to post with the file
 */
async function uploadImageToSlack(botToken, channelId, filePath, title, comment) {
  const fileData = fs.readFileSync(filePath);
  const fileSize = fileData.length;
  const filename = require("path").basename(filePath);

  console.log(`[slack] Uploading ${filename} (${fileSize} bytes) to channel ${channelId}...`);

  // Step 1: Get upload URL
  const uploadUrlResponse = await slackApi(botToken, "files.getUploadURLExternal", {
    filename,
    length: fileSize
  });

  if (!uploadUrlResponse.ok) {
    throw new Error(`files.getUploadURLExternal failed: ${uploadUrlResponse.error}`);
  }

  const { upload_url, file_id } = uploadUrlResponse;

  // Step 2: Upload file data to the URL
  await httpUpload(upload_url, fileData, "image/png");

  // Step 3: Complete the upload and share to channel
  const completeResponse = await slackApiJson(botToken, "files.completeUploadExternal", {
    files: [{ id: file_id, title: title || filename }],
    channel_id: channelId,
    initial_comment: comment || ""
  });

  if (!completeResponse.ok) {
    throw new Error(`files.completeUploadExternal failed: ${completeResponse.error}`);
  }

  console.log("[slack] Image uploaded and shared successfully.");
  return completeResponse;
}

/**
 * Post scoreboard image + commentary text to Slack.
 * Falls back to webhook text-only if bot token isn't configured.
 */
async function postUpdate({ webhookUrl, botToken, channelId, commentary, scoreboardPath }) {
  // If we have a bot token and scoreboard image, upload the image with commentary
  if (botToken && channelId && scoreboardPath && fs.existsSync(scoreboardPath)) {
    await uploadImageToSlack(botToken, channelId, scoreboardPath, "Scoreboard", commentary);
    return;
  }

  // Fallback: text-only via webhook
  if (webhookUrl) {
    await postToSlack(webhookUrl, commentary);
    return;
  }

  throw new Error("No Slack posting method configured. Set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN + SLACK_CHANNEL_ID.");
}

/**
 * Post individual card strips to Slack.
 * 1. Posts header text with commentary
 * 2. Uploads each card strip image in rank order
 * 3. Posts footer text
 *
 * @param {object} opts
 * @param {string} opts.botToken - Slack Bot Token
 * @param {string} opts.channelId - Slack Channel ID
 * @param {string} opts.headerText - Header message (e.g. "🏒 P10: Feb 23 — Nightly Recap")
 * @param {Array} opts.cardPaths - Array of { rank, franchise, filepath } sorted by rank
 * @param {string} opts.commentary - Claude commentary text
 * @param {string} opts.footerText - Footer summary line
 */
async function postCardStrips({ botToken, channelId, headerText, cardPaths, footerText }) {
  if (!botToken || !channelId) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_CHANNEL_ID required for card strip posting.");
  }

  // 1. Post header only (no commentary)
  await slackApiJson(botToken, "chat.postMessage", {
    channel: channelId,
    text: headerText,
  });
  console.log("[slack] Header posted.");

  await new Promise(r => setTimeout(r, 500));

  // 2. Upload each card strip sorted by rank — no text label
  const sorted = [...cardPaths].sort((a, b) => a.rank - b.rank);
  for (const card of sorted) {
    if (fs.existsSync(card.filepath)) {
      await uploadImageToSlack(
        botToken,
        channelId,
        card.filepath,
        `card-${card.rank}.png`,
        ""
      );
      console.log(`[slack] Card ${card.rank} (${card.franchise}) uploaded.`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // 3. Post footer after all cards
  if (footerText) {
    await new Promise(r => setTimeout(r, 300));
    await slackApiJson(botToken, "chat.postMessage", {
      channel: channelId,
      text: footerText,
    });
    console.log("[slack] Footer posted.");
  }

  console.log("[slack] All card strips posted.");
}

// ---- HTTP Helpers ----

function httpPost(url, jsonPayload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(jsonPayload);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpUpload(url, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proto = parsed.protocol === "https:" ? https : require("http");

    const req = proto.request({
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": buffer.length }
    }, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          httpUpload(redirectUrl, buffer, contentType).then(resolve).catch(reject);
          return;
        }
      }
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`Upload HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

function slackApi(token, method, params) {
  return new Promise((resolve, reject) => {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const req = https.request({
      hostname: "slack.com",
      path: `/api/${method}?${queryString}`,
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` }
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from Slack: ${body}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function slackApiJson(token, method, jsonPayload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(jsonPayload);

    const req = https.request({
      hostname: "slack.com",
      path: `/api/${method}`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(data)
      }
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from Slack: ${body}`)); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

module.exports = { postToSlack, uploadImageToSlack, postUpdate, postCardStrips };
