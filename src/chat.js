// ============================================================
// CHAT: one place every bot posts through
// ============================================================
// Sparky chat (the Mattermost-based chat on sparkypool.ca) when CHAT_WEBHOOK_URL is set, otherwise Slack
// the old way (SLACK_BOT_TOKEN + SLACK_CHANNEL). Delete the CHAT_WEBHOOK_URL secret to fall back to Slack.
//
// Sparky chat: an incoming webhook (Slack-style JSON: text, username, icon_url / icon_emoji, channel).
//   The webhook posts to #sparkybots. CHAT_CHANNEL, when set, asks for another channel or a DM
//   ("town-square", "@brian"); the server only honours it if the webhook isn't locked to its channel.
//   The bots write Slack-style text (*bold*, <url|label>), so it's converted to Markdown first:
//   *bold* -> **bold** (single stars are italic there), <url|label> -> [label](url). Code blocks and
//   inline code are left alone.
//
// Env:
//   CHAT_WEBHOOK_URL                  Sparky chat incoming webhook (a secret: it works as a password)
//   CHAT_CHANNEL                      optional channel override for the webhook (test posts)
//   SLACK_BOT_TOKEN, SLACK_CHANNEL    the Slack fallback
// ============================================================

const WEBHOOK = process.env.CHAT_WEBHOOK_URL || "";
const CHAT_CHANNEL = process.env.CHAT_CHANNEL || "";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "";

const where = () => (WEBHOOK ? "Sparky chat" : SLACK_TOKEN && SLACK_CHANNEL ? "Slack" : null);
const configured = () => !!where();

// Slack mrkdwn -> Markdown, outside code
function toMarkdown(text) {
  return String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => {
    if (i % 2) return part;                                                       // code: untouched
    return part
      .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1**$2**");
  }).join("");
}

const iconFields = (icon) => (!icon ? {} : String(icon).startsWith("http") ? { icon_url: icon } : { icon_emoji: icon });

// post(text, { username, icon }) -> true when sent, false when nowhere is configured; throws on a failed send
async function post(text, { username, icon } = {}) {
  if (WEBHOOK) {
    const body = { text: toMarkdown(text), ...(username ? { username } : {}), ...iconFields(icon), ...(CHAT_CHANNEL ? { channel: CHAT_CHANNEL } : {}) };
    const r = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Sparky chat: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return true;
  }
  if (SLACK_TOKEN && SLACK_CHANNEL) {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false, ...(username ? { username } : {}), ...iconFields(icon) }),
    });
    const o = await r.json();
    if (!o.ok) throw new Error(`Slack: ${o.error}`);
    return true;
  }
  return false;
}

module.exports = { post, configured, where, toMarkdown };
