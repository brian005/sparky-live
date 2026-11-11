# CLAUDE.md - Sparky Live

Operating manual for any Claude session working in this repo. Read it first;
update it at the end of every day this repo is worked on (newest entry at the
top of the Change log).

## What this repo is

The Sparky League's nightly automation on GitHub Actions: scrapes, reports and
Slack posts for a 6-team fantasy hockey league. The league's source of truth is
**F2** (sparkypool.ca, Chris's Fantrax clone). Fantrax is now a **mirror** kept in
sync by the janitor, so owners keep a transparent copy.

**This repo is PUBLIC.** Never commit secrets, tokens, Slack IDs that aren't
already public, or anything owner-private. Credentials live only in Actions
secrets/variables. Committed reports in `data/` are visible to anyone.

## Workflows (all times Pacific; crons are UTC and don't follow DST)

| Workflow | Script | When | Posts as |
|---|---|---|---|
| `f1-replicate.yml` - Fantrax janitor | `src/f1-replicate.js` | 23:00 PDT / 22:00 PST nightly, plus Mondays 14:00 PDT / 13:00 PST (pre-lock) | Belding (#sparkybots) |
| `records.yml` - Records | `src/records.js` (+ `src/night-records.js`, `src/record-pics.js`; first run also `src/player-nights-backfill.js`) | 22:30 / 23:30 PDT | Screech |
| `nightly-report.yml` | `src/nightly-report.js` | 09:00 PDT | Lisa Turtle |
| `sunday-report.yml` | `src/projection-report.js` | Sundays 09:30 PDT | Lisa Turtle ("F2 stats department") |
| `bench-streaks.yml` | `src/bench-streaks.js` | 18:05, night before lock | Zack Morris |
| `scorigami.yml` | `src/scorigami.js` | 08:00 PDT | - |
| `lines.yml` - Daily Faceoff lines for Sparky Lens | `src/df-lines.js` | every 2 h at :17 | - (commits `data/lines/latest.json`) |
| `game-night.yml` | `src/index.js` | recap | - |
| `backfill.yml`, `test-post.yml` | manual only | - | - |

The Saved by the Bell persona bots post to **#sparkybots**, not #sparky.

## Chat (Sparky chat on sparkypool.ca, formerly Slack)

- Every active bot posts through `src/chat.js`: **Sparky chat** (Chris's Mattermost-based chat
  in F2) when the workflow passes a `CHAT_WEBHOOK_URL`, otherwise Slack the old way
  (`SLACK_BOT_TOKEN` + `SLACK_CHANNEL`).
- **One webhook per bot (since 2026-11-11, from Chris), each locked to its channel.** Actions
  secrets: `CHAT_HOOK_LISA` (nightly-report, sunday-report), `CHAT_HOOK_ZACK` (bench-streaks),
  `CHAT_HOOK_SCREECH` (records), `CHAT_HOOK_BELDING` (f1-replicate), all #sparkybots, and
  `CHAT_HOOK_TEST` (#brian-test). Each workflow maps its bot's secret to `CHAT_WEBHOOK_URL`;
  the `channel` input's only value now is `brian-test`, which swaps in the test webhook (a
  locked webhook refuses any other channel, so `CHAT_CHANNEL` is always blank). The old shared
  "Brian's bots" webhook (`CHAT_WEBHOOK_URL` secret) is retired. Sparky Lens's Zack recap uses
  the Zack webhook as its `F2_CHAT_WEBHOOK` secret.
- The bots still write Slack-style text; `chat.js` converts it: `*bold*` -> `**bold**` (single
  stars are italic in Sparky chat), `<url|label>` -> `[label](url)`. Code is left alone.
- Not migrated (still Slack-only, all disabled): `scorigami.js`, `index.js` / `slack.js`
  (Game Night), `test-post.js`.
- The webhook URL and the sparkybot API key work as passwords: Actions secrets only, never
  committed (this repo is public).

## The janitor (f1-replicate) - read before touching it

- Sweeps **every locked F2 period**, oldest to newest, fixes whatever on Fantrax
  differs from F2, re-reads to prove it, then compares season points. Idempotent:
  nothing differs, nothing is written. A missed night is harmless - the next run
  sweeps everything.
- **Two passes per run.** (1) Every *locked* F2 period: full mirror (trades,
  claims, drops, lineups). (2) The *next, unlocked* period: **membership only**
  (trades, claims, drops), carried forward to later periods, so moves made during
  Period N are on Fantrax's Period N+1 rosters **before N+1 starts**. Lineups for the
  upcoming period are left alone: owners can change them until lock, and the
  lock-night sweep sets them. Added 2026-10-27 after a Period 2 trade (Quinn <->
  Nazar) was refused by Fantrax once Period 3 was already underway.
- The upcoming pass reads F2's `/api/teams/{id}/roster?rcp=N+1` (the ledger replayed
  to N+1). If F2 doesn't serve it or it fails sanity checks, that pass is skipped
  with a note; it never fails the locked sweep. `--no-upcoming` turns it off;
  `--period N` on an unlocked period runs the upcoming pass for it alone.
- The Monday 14:00 run exists because periods start and lock on Monday afternoons
  (F2 `lock_ts`, naive Pacific): it catches moves made between Sunday's 23:00 run and
  the lock. On off-week Mondays it's a no-op.
- **Trades Fantrax refuses** are retried ONCE with the commissioner override (F2
  already approved them). The result and the Slack post say "applied with
  commissioner override". Claims/drops are never forced (`PROMPT_FOR_OVERRIDE` is
  reported, not overridden).
- **Membership guard:** trades + claims + drops per run above
  `MAX_MEMBERSHIP_CHANGES` (repo variable, set to **40** on 2026-10-27; code default
  12) stops the run before any write. Lock nights legitimately run 30+ (no
  mid-period waivers, so two weeks of moves land at once). Over the limit: check F2,
  then dispatch with `force`.
- **Fantrax calls** (`fx()`): each in-page fetch has a 45s deadline; Puppeteer's
  `protocolTimeout` sits above it. `get*` (read) calls retry 3x (5s, 15s); **write
  calls never retry** - a timed-out write may have landed, and the next run
  re-reads anyway. Don't add write retries.
- Scheduled runs are quiet: Slack only on a lock night (receipt), anything fixed or
  failed, an unplaced player, or points that disagree. Manual runs always post.
- Every run commits a JSON report to `data/f1-replicate/YYYY-MM-DD-HHMMZ-p<a>-<b>-<mode>.json`
  (UTC time added 2026-10-29; older files have no `HHMMZ`). That is the audit trail
  AND the repo activity that stops GitHub disabling schedules after 60 quiet days.
  `p1-3` = locked periods 1-3 swept; the upcoming period is `report.upcoming` and an
  entry in `periods` with `upcoming: true`.
- **Points parity baseline:** F2 at 23:00 counts games through yesterday; Fantrax
  already counts tonight's. So F2 tonight is compared to Fantrax as recorded by the
  report closest to exactly 24h old (window 18-30h), chosen by `report.at`, never by
  filename. A manual run the evening before is NOT a fair baseline (fewer games).
- Offline harness: build a fake F2 API + fake Fantrax (stub Puppeteer page whose
  `evaluate` answers `/fxpa/req` bodies) + fake Slack, then `require` the script with
  args. That's how the upcoming pass and override retry were tested on 2026-10-27
  (pre-set, dry-run, `--period 4`, `--no-upcoming`, F2 404 on the future period).

Dispatch (from Brian's PowerShell):
`gh workflow run f1-replicate.yml --repo brian005/sparky-live -f mode=apply -f force=true`
(`mode`: dry-run | apply | verify-only; optional `-f period=N`).

## Monitoring

- **Sparky Heartbeats** (a separate Apps Script sheet) polls this repo's workflow
  runs hourly; Brian's agent **Danny** reads it and DMs a 10:45 AM brief.
- Danny opens issues here titled `[heartbeats] <job> - <cause>` for persistent
  faults. Reference them in fix commits (`fixes #N`).
- **Parked (2026-10-27, Brian: "not yet"):** an issue-triggered Claude responder -
  Danny opens a `[heartbeats]` issue, an Action runs Claude in the repo, Claude
  replies in the issue (diagnosis or fix PR), Danny relays it in his brief, Brian
  merges. Gate on issues authored by brian005 (repo is public). Needs an
  `ANTHROPIC_API_KEY` secret here. Revisit when Brian says the flow is ready.
- The janitor is an immediate-page job only on the night after a lock.

## Conventions

- Node 20, CommonJS, LF line endings. Deps: puppeteer (+extra/stealth),
  googleapis, @anthropic-ai/sdk, canvas.
- Brian works in Windows PowerShell. Deliver complete files and one-line
  PowerShell blocks for every step (git, gh), in run order.
- **Delivering files:** right above the file cards, a destination map - one
  repo-relative path per line, each in inline code (backticks), never a fenced block,
  never inside a paragraph, nothing else on the line.
- Claude's file bridge can't write into `.github/workflows`: a workflow change lands as `incoming/<name>.yml`
  and Brian's PowerShell moves it into `.github/workflows/` before committing.
- **Always `git pull --rebase` before pushing** - workflows commit reports nightly,
  so local copies are always behind.
- `src/config.js` still carries the 2025-26 Fantrax `PERIODS` table; check whether
  a script reads it before trusting it for 2026-27 (F2 periods are authoritative).
- Strings: "Projected" not "Proj"; "Won N straight periods"; a period win means
  finishing #1 in points.

## Night records (Screech, and Sparky Lens)

- `src/night-records.js`: every finished night, at four levels per stat (pool, pool in a Period N night, the
  franchise's own, its own in a Period N night), records AND ties, a value must be above zero, a level needs one
  earlier night. Stats: points, ppg (5+ GP), points from one NHL game, goals, primary points (G + A1), PP points,
  EN points, prospect points, different prospects scoring (old rule: pool/own any-night only, no ties),
  DOMINATION (outscoring everyone else combined: each one noted; the margin has records); the whole pool's points
  and ppg (20+ GP) per night. Brian (2026-11-02): report everything first, judge the volume later.
- **Volume rules (Brian, 2026-11-06).** A franchise's own tie (FRANCHISE RECORD / P5 FRANCHISE RECORD) is announced
  only when it ties at most 2 other nights (`OWN_TIE_MAX`); past that the next level down is tried, so a tie of its
  any-night best can still come out as a Period N record. Pool ties always count. Same for period records
  (`bestLevel` in `records.js`). DOMINATION (and its margin records) doesn't fire on a night two or more franchises
  had nobody playing (GP 0; an unknown GP doesn't count), in history as tonight; any other night it fires, whatever
  the score ("give it a go"). Replay Sep 29 - Nov 5: 54 lines to 37 (8 own ties of 5-9 other nights and 2
  DOMINATIONs on two-idle nights gone; MPP's Oct 16 margin is now a tie of its own +4 instead of a P2 record).
- History: `data/daily-*` (points, GP), `data/active-stints.json` (every Active player x period x franchise
  2013-14..2025-26, exported once from the local F2 copy's `player_period_pts`; NHL ids for 100 old players
  matched by name; Elias Pettersson fixed to 8480012), `data/player-nights/YYYY-YY.json` (built by
  `src/player-nights-backfill.js` from `api-web.nhle.com/v1/score/{date}`; checks itself against the daily files
  and F2's period points, and swaps any NHL id that isn't that season's skater of that name and position).
  The goals / primary / PP / EN / one-game stats stay off until every season's player-nights file exists.
- This season: `data/nightly-report/*.json` now keep each Active scorer's g/a1/a2/pp/en/game and each team's
  points per NHL game (`teams[id].games`).
- Screech posts as cards (message attachments; `src/chat.js` sends `attachments`): a header line, then one card a
  record. Colour by level (gold pool, orange pool Period N, green own, blue own Period N, red DOMINATION, purple the
  whole pool), the franchise (the card's top line; its logo only with `CARD_LOGOS=1`, see below), a one-line title ("⭐ P3 FRANCHISE RECORD", "🤝 TIED
  · SPARKY RECORD"), "_all-time_" on pool records only, what it is ("Most goals in a Period 2 night"), the number in
  bold ("*8 power-play points*"), then the old mark or the nights it ties. Period, milestone, player and prospect
  lines go in plain cards. Every card carries its sentence as `fallback`. Designed at phone width (no thumbnails:
  they drop below the text there).
- **Where the league reads it: F2's own chat panel** (`sparkypool.ca/app/chatapp.js`, Chris's Slack-style client
  opened by F2's chat button), not Mattermost's web app at `/chat`. Its cards (`attHtml` / `md()`) do bold, italic,
  links, lists, quotes and line breaks, and **no headings**: a `### 8` prints the #s. Preview cards there (F2 page,
  `.nc` classes), not in Mattermost's UI: the 2026-11-02 cards were previewed in Mattermost, where `###` is a big
  number, and the league saw `### 8 power-play points`.
- **No logos on the cards for now (2026-11-05).** F2's chat panel (`picsHtml`) draws every picture in the post's
  `metadata.images` full size under the post, and Mattermost puts each card's `author_icon` there whenever its server
  can fetch it: the fantraximg.com logos (BEW, GDD, JGC, RMS) yes, F2's own `/logo/` ones (PWN, MPP) no. Nov 4's
  DOMINATION card had RMS's logo 350 px tall under it. `records.js` sends no `author_icon` unless `CARD_LOGOS=1`; turn
  it back on once the panel skips pictures its cards already show (Chris's side: in `picsHtml`, skip `md.images` URLs
  that are an attachment's `author_icon` / `image_url` / `thumb_url` / `footer_icon`). Check a preview's
  `metadata.images`, not just the cards: a post built by hand in the panel has none.
- DOMINATION card: "*6 points*" then "The other five combined: 5" (it was "6 – 5", which read like a score).
- Names and wording (Brian, 2026-11-02), a name and a line under it: SPARKY RECORD / all-time (any franchise,
  any night, gold); P5 RECORD / all-time (any franchise, a Period 5 night, orange); FRANCHISE RECORD / Brian's
  Endless Winter (that franchise's own, any night, green); P5 FRANCHISE RECORD / Brian's Endless Winter (its own in
  a Period 5 night, blue). The whole league added up (Brian, 2026-11-08: "SPARKY" and "ALL-TIME" records, never
  "pool" or "whole-pool"): SPARKY RECORD / P5 RECORD, all-time, purple, with "Sparky record" and the Sparky logo where
  a franchise's name and logo go (its sentence: "The Sparky League set the record for ...").
  A card says the record once ("Most points from one NHL game in a Period 1 night") then only the number and its
  unit ("7 points", "1 power-play point"). The franchise is the card's top line, so a franchise record doesn't
  repeat it under the title. An old mark names the franchise only on a pool record; a franchise's own record is
  obviously its own ("Old mark: 7 · Nov 1, 2018"). A tie says how many other nights it ties, with the date (and on a
  pool record the franchise) only when it's one: "Ties 1 other night: Nov 11, 2023", "Ties 4 other nights" (Brian,
  2026-11-04; period and prospect-period ties the same, "Ties 1 other period: 2022-23", "Ties 3 other periods"). The DOMINATION margin stat
  is "biggest margin of victory".
- **Pictures (since 2026-11-06, Brian: "Lets do it as pictures").** In Sparky chat every night and period record is
  a picture, not a text card (`src/record-pics.js`): a 400x240 card (800x480 PNG) drawn from HTML by headless Chrome
  on the command line (the runner's `google-chrome`; still no npm install), Barlow Condensed + Poppins from
  `assets/fonts/` (OFL), the franchise logo from F2's teams (else `data/logos/`), the level's colour, the record's
  name ("TIED · P3 FRANCHISE RECORD", "ALL-TIME" tag on pool levels), what it is, the number big, the old mark or the
  nights it ties (an old holder by initialism: "1.14 · MPP · 2025-26"), the night or period top right. DOMINATION has
  bars (the franchise against the other five). Each card in `night-records.js` / `records.js` carries a `pic` layout;
  `records.js` strips it off for text cards.
  - Whose record it is (Brian, 2026-11-08): a big faded logo cut off by the bottom-right corner (`pic.wm`): the
    franchise's own logo on its FRANCHISE / P5 FRANCHISE records and a DOMINATION; the Sparky logo on every all-time one
    (SPARKY / P5 RECORD, a franchise's or the whole league's). The Sparky S is `assets/sparky-logo.png` (see-through,
    cut from Brian's art; Sparky Lens loads the same file from raw.githubusercontent.com).
  - How they get into the chat: the PNGs are committed to `data/records/pics/` and pushed from inside the run
    (`git pull --rebase --autostash`, 4 tries), then posted as `![](raw.githubusercontent.com/<repo>/<sha>/...)` on the
    header's line (F2's `md()` drops the image text but keeps line breaks). Mattermost lists them in
    `metadata.images` (sorted by URL, hence the -01, -02 names) and F2's `picsHtml` draws each 330 px wide. The run
    waits until GitHub serves every picture before posting. 4 pictures a post ("(1 of 3)"); milestones (all-time
    points and prospect points) and player lines follow as text cards in a post of their own.
  - Prospect period records are pictures in their period's section, with who scored under the number (last names
    when the full list won't fit); prospect season records are pictures in the night they're passed ("and
    counting", the night top right), in that night's section even when it has no night records (since 2026-11-09).
  - Pictures older than 14 days leave the tree in the same commit (each is ~190 KB and every workflow checks out the
    tree); old posts keep working because their URLs are pinned to a commit.
  - Fallback: no Chrome, a push that won't go, or a picture GitHub won't serve, and the whole post goes out as text
    cards (as before); `RECORD_PICS=0` does it on purpose; Slack always gets text cards. `--no-slack` makes none.
  - `chat.js` sends a webhook post once more if the connection dropped (F2 and the chat share a host; a kept-alive
    socket can go stale while the pictures draw).
  - Offline test: a stand-in F2 + webhook server, `RECORD_PICS_URL_BASE=http://localhost:PORT/raw` (skips git),
    `RECORDS_DIR=<temp>` for a fresh state; `--replay-from 2026-10-25 --test` gave 9 pictures in 3 posts, a fresh
    state at `--today 2026-11-12` gave 43 (periods 1-3 and every night) in 11 posts plus the text-card post.
- `--replay-from YYYY-MM-DD` (workflow input `replay`) prints what the night records would have said; with a
  channel it test-posts. `data/records/lens.json` (v 2) is the record book + the last 14 nights' records and
  DOMINATIONs for Lens, each with its picture layout (`pic`), rewritten by every real run (not `--test`) and committed
  with the state. Sparky Lens (1.49.0+) reads it straight from raw.githubusercontent.com for LAST NIGHT's RECORDS
  section; keep `pic`'s fields as they are, or change Lens's `lnRecCard` with them. The Drive copy
  (`RECORDS_DRIVE_URL` / `RECORDS_TOKEN`, never set) isn't needed.

## Lines feed (for Sparky Lens)

- `src/df-lines.js` reads Daily Faceoff's 32 line-combination pages once (1.5 s apart, honest User-Agent, waits and
  retries on 429/5xx) and writes `data/lines/latest.json`: `{ v: 1, src, at, failed, rows }`, rows exactly as Lens
  builds them (`summarizeTeam` is copied from Lens's `background.js`; keep the two identical). Only each skater's
  slots: EV line, PP/PK units, linemates' names. No goalies, no IR list.
- Every Sparky Lens reads that file (raw.githubusercontent.com, CORS open, cached ~5 min) hourly instead of scraping
  Daily Faceoff itself; if it's missing or 8+ h old, Lens reads Daily Faceoff on its own as before. So a failed or
  skipped run costs nothing. Brian (2026-11-03): the point is sharing Lens with the league ("fun is to be maximized")
  without six browsers each hitting Daily Faceoff.
- A failed team page keeps its rows from the last file and is listed in `failed`; more than 8 failures stops the
  run without publishing (a 403 / challenge page means Daily Faceoff is turning GitHub's runners away: if that
  sticks, disable `lines.yml` and Lens carries on reading Daily Faceoff itself). The file is rewritten only when a
  row changed or the last read is 5+ h old, so quiet runs commit nothing.
- Offline test: a stand-in Daily Faceoff (32 pages in the `__NEXT_DATA__` shape) via `DFO_BASE`, `DFO_PACE_MS=0`.

## Change log

- **2026-11-11** - Per-bot webhooks. Chris issued one webhook per bot, each locked to its channel, plus one for
  #brian-test; the shared webhook and the sparkybot token (Danny's relay, a 401 since about Nov 10) look retired. The
  five posting workflows read their bot's `CHAT_HOOK_*` secret; test posts use `channel=brian-test`. Danny has no
  webhook of his own yet. Workflow files shipped from `scratch/` (the file bridge can't write `.github/workflows`).
- **2026-11-09** - Prospect period and season records are pictures too (Brian, about Richie's Period 3 prospect
  record arriving as a text card under the period's pictures). `prospectChecks` returns `{ line, pic }`
  (`periodRecs`, `nightRecs`); the 100s stay text (`nightLines`). A season record passing a mark someone set earlier
  this season now names it ("Old mark: 9, ..., 2026-27"). Replayed the Period 3 night offline (5 pictures, no text
  post) and a shrunken prospect history (20 pictures: pool, P2 and own period records, own and pool season records).
- **2026-11-08** - Screech's pictures say whose record it is (Brian): a faded franchise logo in the corner of a
  franchise's own records, the Sparky S on all-time ones; the whole league's records are "Sparky record" with the Sparky
  logo, named SPARKY RECORD / P5 RECORD (no more WHOLE-POOL). `assets/sparky-logo.png`, `pic.wm`. Replayed Oct 15 -
  Nov 7 offline (20 pictures) and checked them; Lens's RECORDS cards match (Lens 1.49.3).
- **2026-11-06 (latest)** - Volume rules (see "Volume rules" under Night records): own ties of 3+ other nights /
  periods skipped (`OWN_TIE_MAX`, next level tried instead), no DOMINATION when 2+ franchises had nobody playing.
- **2026-11-06 (later)** - `lens.json` v 2: every night record and DOMINATION carries its picture layout (`pic`) for
  Sparky Lens's new RECORDS section (Brian: "Show night records in lens").
- **2026-11-06** - Screech posts pictures (see "Pictures" under Night records): `src/record-pics.js`, `assets/fonts/`,
  a `pic` layout on every night and period record card, `postRecords` in `records.js`, one retry for a dropped
  webhook connection in `chat.js`. Tested offline end to end (render, post order, text fallback for the rest, the
  commit/prune/autostash/push against a local remote).

- **2026-11-05** - Screech's Nov 4 DOMINATION card (Brian: "This looks like waz"): RMS's logo printed full size
  under the card, because F2's chat panel draws every picture Mattermost lists in `metadata.images`, which includes the
  cards' `author_icon` when Mattermost can fetch it (fantraximg.com logos; F2's own `/logo/` ones it can't, which is
  why Nov 3's MPP cards looked fine). Logos off behind `CARD_LOGOS` until the panel skips them. DOMINATION reads
  "*6 points*" / "The other five combined: 5" instead of "6 – 5". Checked against the real Nov 4 post's metadata and
  F2's `picsHtml` / `attHtml`.

- **2026-11-04** - Screech's cards fixed for F2's chat panel, where the league reads them (Brian: "That seems
  off"): the number is bold instead of a `### ` heading (the panel prints the #s); the franchise isn't repeated
  under the title (it's the card's top line; pool records still say "all-time"); old marks and ties on a
  franchise's own record leave out the franchise; ties say how many other nights (or periods) they tie, with the
  date only when it's one ("Ties 1 other night: Nov 11, 2023", "Ties 4 other nights"); "1
  power-play point", not "1 power-play points". Previewed with F2's own chat styles; replayed the Nov 3 night's
  two records and pool / own ties of 1, 2, 3 and 5+ other nights through the real wording.

- **2026-11-03** - Lines feed for Sparky Lens (`src/df-lines.js`, `lines.yml`): see "Lines feed". Tested offline
  against a stand-in Daily Faceoff (first read, nothing changed, a line swap, one page down, a 429, blocked, challenge
  pages) and with Lens reading the file (fresh, unchanged, 9 h old, missing). Whether Daily Faceoff serves GitHub's
  runners is only known after the first real run.

- **2026-11-02 (later)** - Screech's posts are cards now (see "Night records"). Previewed in the real Sparky chat
  web app at phone width before shipping. Backfill built: 2,222 nights, 2 franchise-nights off by a point, no id
  fixes needed; replay since Sep 29: 29 lines over 34 nights (16 ties, 8 records, 5 DOMINATIONs).
- **2026-11-02** - Night records rebuilt (see "Night records" above): four levels per stat, eleven stats,
  records and ties, DOMINATION. Prospect night records moved into the new module (now four levels with ties for
  points). Player-nights backfill + active-stints export added; verified on five real nights (2013-14, 2017-18,
  2020-21, 2022-23, 2025-26): every franchise-night matched the daily files once Pettersson's id was fixed
  (PWN's 26 on Nov 19, 2022 reproduced exactly). Replay of 2026-27 so far (before player-nights): about one line
  every other night.
  Same day: the nightly `--backfill` died on an NHL 429 (rate limit) after ~300 calls. Both NHL fetchers now wait
  and retry on 429 / 5xx (Retry-After, else 5s..90s); the player-nights backfill paces itself at ~2 calls a second.

- **2026-11-01** - Moved every active bot (Belding, Screech, Lisa Turtle nightly + Sunday,
  Zack Morris) from Slack to Sparky chat via a new `src/chat.js` and the `CHAT_WEBHOOK_URL`
  secret; Slack stays as the fallback.

- **2026-10-29** - Points-parity false alarm on the Oct 28 23:00 run (all six teams
  "differed" by 3-8). Cause: `previousRun()` picked the baseline by filename, and
  `...-dry-run.json` sorts ahead of `...-apply.json`, so Brian's 18:51 PT manual
  dry-run (pre-games) beat the 23:00 nightly. Danny caught it; F2's totals matched the
  nightly baseline exactly. Fix: baseline chosen by `report.at`, closest to 24h; report
  filenames now carry `HHMMZ` so same-day runs stop overwriting each other (that had
  also cost the Oct 27 nightly baseline). Upcoming pass confirmed working: F2 serves
  `rcp=4`; Period 4 pre-set plan was empty (nothing pending) on Oct 28 and 29.
- **2026-10-27 (later)** - Upcoming-period pass (trades/claims/drops pre-set into
  the next period before it locks), Monday 14:00 pre-lock schedule, one-shot
  commissioner-override retry for refused trades. Forced Period 3 run had applied
  31/32 membership changes + all lineups (points match all 6); only Quinn <-> Nazar
  was refused - the override retry is aimed at it.
- **2026-10-27** - Lock night for Period 3: janitor tripped the membership guard
  (33 > 12). Nothing written. Plan reviewed against F2; guard raised to 40 via
  repo variable; Period 3 applied with a forced manual run. This CLAUDE.md created.
- **2026-10-20** - Janitor failed once ("Runtime.callFunctionOn timed out": a
  Fantrax request never answered). Fixed in `b35ed31`: 45s fetch deadline,
  protocolTimeout headroom, read retries, no write retries (issue #1).
