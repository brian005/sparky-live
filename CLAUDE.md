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
| `records.yml` - Records | `src/records.js` | 22:30 / 23:30 PDT | Screech |
| `nightly-report.yml` | `src/nightly-report.js` | 09:00 PDT | Lisa Turtle |
| `sunday-report.yml` | `src/projection-report.js` | Sundays 09:30 PDT | Lisa Turtle ("F2 stats department") |
| `bench-streaks.yml` | `src/bench-streaks.js` | 18:05, night before lock | Zack Morris |
| `scorigami.yml` | `src/scorigami.js` | 08:00 PDT | - |
| `game-night.yml` | `src/index.js` | recap | - |
| `backfill.yml`, `test-post.yml` | manual only | - | - |

The Saved by the Bell persona bots post to **#sparkybots**, not #sparky.

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
- Every run commits a JSON report to `data/f1-replicate/YYYY-MM-DD-p<a>-<b>-<mode>.json`.
  That is the audit trail AND the repo activity that stops GitHub disabling
  schedules after 60 quiet days. Filename `p1-3` = locked periods 1-3 swept; the
  upcoming period is `report.upcoming` and an entry in `periods` with
  `upcoming: true`.
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
- The janitor is an immediate-page job only on the night after a lock.

## Conventions

- Node 20, CommonJS, LF line endings. Deps: puppeteer (+extra/stealth),
  googleapis, @anthropic-ai/sdk, canvas.
- Brian works in Windows PowerShell. Deliver complete files and one-line
  PowerShell blocks for every step (git, gh), in run order.
- **Always `git pull --rebase` before pushing** - workflows commit reports nightly,
  so local copies are always behind.
- `src/config.js` still carries the 2025-26 Fantrax `PERIODS` table; check whether
  a script reads it before trusting it for 2026-27 (F2 periods are authoritative).
- Strings: "Projected" not "Proj"; "Won N straight periods"; a period win means
  finishing #1 in points.

## Change log

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
