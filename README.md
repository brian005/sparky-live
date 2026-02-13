# 🏒 Sparky Live

Automated live scoring commentary for the Sparky League. Scrapes Fantrax during game nights, generates AI commentary via Claude, and posts updates to Slack.

## How It Works

```
Fantrax Live Scoring Page
    ↓ Puppeteer scrapes standings
Snapshot saved (JSON)
    ↓ compared to previous snapshot
Context built (live data + changes + historical records)
    ↓ sent to Claude API
Commentary generated
    ↓ posted via webhook
Slack channel
```

Runs automatically via GitHub Actions every hour during NHL game windows (7pm–1am ET, Oct–Jun).

## Setup

### 1. Create the GitHub repo

```bash
git init sparky-live
cd sparky-live
# Copy all files from this project
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/sparky-live.git
git push -u origin main
```

### 2. Add GitHub Secrets

Go to your repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|--------|-------|
| `FANTRAX_USERNAME` | Your Fantrax login email |
| `FANTRAX_PASSWORD` | Your Fantrax password |
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |

### 3. Set the current period

Go to Settings → Secrets and variables → Actions → Variables tab → New repository variable:

| Variable | Value |
|----------|-------|
| `CURRENT_PERIOD` | `9` (update each period) |

### 4. Create a Slack Incoming Webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create a new app (or use your existing SparkyBot app)
3. Enable **Incoming Webhooks**
4. Create a webhook for your league channel
5. Copy the webhook URL to GitHub Secrets

### 5. Export historical data

In your Google Sheets Apps Script project, add the function from `src/export-history.gs`. Run it, then:

1. Copy the JSON output from the "JSON Export" tab
2. Save it as `data/historical.json` in this repo
3. Commit and push

This gives Claude historical context for commentary (franchise records, period rankings, etc.).

## Usage

### Automatic (GitHub Actions)

The workflow runs automatically on the cron schedule. Update `CURRENT_PERIOD` in repo variables when a new period starts.

### Manual trigger

Go to Actions → "Game Night Live Scoring" → Run workflow. You can set:
- **Period number**
- **Commentary type**: `update` (mid-game) or `nightly` (end-of-night recap)
- **Dry run**: Test without posting to Slack

### Local testing

```bash
npm install

# Dry run (scrape + analyze, no Slack post)
FANTRAX_USERNAME=you@email.com \
FANTRAX_PASSWORD=yourpass \
CURRENT_PERIOD=9 \
node src/index.js --dry-run

# Full run
FANTRAX_USERNAME=you@email.com \
FANTRAX_PASSWORD=yourpass \
ANTHROPIC_API_KEY=sk-ant-... \
SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
CURRENT_PERIOD=9 \
node src/index.js

# Debug with visible browser
HEADLESS=false node src/index.js --dry-run
```

## File Structure

```
sparky-live/
├── .github/workflows/
│   └── game-night.yml      # GitHub Actions cron workflow
├── data/
│   ├── historical.json      # Exported from Google Sheets Database
│   └── snapshots/           # Scrape history (auto-committed)
├── src/
│   ├── index.js             # Main orchestrator
│   ├── scrape.js            # Puppeteer Fantrax scraper
│   ├── analyze.js           # Context builder + snapshot management
│   ├── commentary.js        # Claude API commentary generator
│   ├── slack.js             # Slack webhook poster
│   └── export-history.gs    # Apps Script utility for historical export
├── package.json
└── README.md
```

## Updating for a New Season

1. Update franchise names in `src/analyze.js` → `FRANCHISE_MAP`
2. Update franchise names in `src/commentary.js` → `FRANCHISE_NAMES`
3. Re-export `data/historical.json` from Google Sheets
4. Update `CURRENT_PERIOD` variable in GitHub repo settings

## Troubleshooting

**Login failing**: Fantrax may have changed their login form. Run locally with `HEADLESS=false` to see what's happening. Check for CAPTCHA or changed input selectors.

**No teams found**: The Angular DOM structure may have changed. Run with `HEADLESS=false`, inspect the page, and update selectors in `src/scrape.js`.

**GitHub Actions timing**: The cron schedule uses UTC. Adjust the hours in `.github/workflows/game-night.yml` if your timezone offset changes (DST).
