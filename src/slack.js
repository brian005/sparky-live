// ============================================================
// SLACK POSTER
// ============================================================
// Posts commentary to Slack via incoming webhook.
// ============================================================

const https = require("https");
const url = require("url");

/**
 * Post a message to Slack via incoming webhook.
 * 
 * @param {string} webhookUrl - Slack incoming webhook URL
 * @param {string} text - Message text (supports Slack markdown)
 * @param {object} options - Optional: { username, icon_emoji }
 */
async function postToSlack(webhookUrl, text, options = {}) {
  const payload = {
    text,
    username: options.username || "SparkyBot",
    icon_emoji: options.icon_emoji || ":hockey:"
  };

  return new Promise((resolve, reject) => {
    const parsed = new URL(webhookUrl);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("[slack] Message posted successfully.");
          resolve(body);
        } else {
          reject(new Error(`Slack returned ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on("error", reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

module.exports = { postToSlack };
