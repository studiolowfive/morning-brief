# Morning Brief

A local daily intelligence agent for Alex Stahlmann / Studio Low Five. It collects market signals, deduplicates them, scores them against Alex's business priorities, generates a strategist-style Markdown report, and posts it to ClickUp.

This is intentionally not a news aggregator. The report is designed to answer: what happened, why it matters, why Alex should care, what Alex could say, what Alex could do, and how urgent it is.

## Quick Start

```bash
npm run setup
npm run test:connectors
npm run collect
npm run report
npm run post:clickup
```

`npm run setup` creates `data/`, `logs/`, and a local `.env` from `.env.example`.

## Commands

```bash
npm run setup            # create local folders and .env
npm run test:connectors  # fetch a few items from each enabled source
npm run collect          # collect raw signals into data/signals.jsonl
npm run report           # generate a report from stored signals
npm run post:clickup     # post the latest report to ClickUp
npm run daily            # collect, generate, and post on weekdays only
```

Weekend behavior: `npm run daily` collects on Saturday and Sunday but does not post. Monday reports include a `Weekend Catch-Up` section and use a wider report window.

## Sources

Edit `config/sources.json`.

To add an RSS source:

```json
{
  "id": "example-feed",
  "enabled": true,
  "name": "Example Feed",
  "url": "https://example.com/rss.xml",
  "topics": ["brand voice", "workflow prompts"]
}
```

To disable a source, set `"enabled": false`.

### Reddit (recommended: OAuth)

Anonymous Reddit endpoints (`.rss` and public `.json`) are aggressively rate-limited and routinely return `429 Too Many Requests` from shared or cloud IPs. The reliable fix is an authenticated "script" app:

1. Go to https://www.reddit.com/prefs/apps and create an app of type **script**.
2. Put the client id, secret, your Reddit username, and password in `.env`:

```bash
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=
REDDIT_USER_AGENT=morning-brief/0.1 by /u/yourname
```

When these are set, the agent authenticates against `oauth.reddit.com` (its own ~100 req/min budget) and only falls back to the public routes if the token request fails.

V1 supports:

- RSS feeds
- Reddit subreddit feeds through authenticated OAuth (recommended), with public JSON/RSS fallback
- Bluesky search with a free app password
- YouTube RSS search entries, disabled by default because reliability varies
- Manual/fallback sources through `data/manual-signals.jsonl`

Manual signals should be JSONL rows shaped like:

```json
{"id":"manual:linkedin-001","connector":"manual","sourceId":"linkedin-manual","sourceName":"LinkedIn","title":"Post title or conversation summary","url":"https://...","summary":"Why this is interesting","publishedAt":"2026-06-27T15:00:00.000Z","collectedAt":"2026-06-27T15:05:00.000Z","topics":["brand voice"]}
```

## ClickUp Setup

Add these to `.env`:

```bash
CLICKUP_API_TOKEN=
CLICKUP_WORKSPACE_ID=
CLICKUP_CHANNEL_ID=
CLICKUP_FALLBACK_LIST_ID=
```

If your ClickUp workspace exposes a specific Channel message endpoint, set:

```bash
CLICKUP_CHANNEL_POST_URL=
```

The agent tries Channel posting first. If that fails, it creates a fallback task named `Morning Brief - YYYY-MM-DD` in `CLICKUP_FALLBACK_LIST_ID` with the full report in the description.

No credentials are hardcoded. Keep `.env` local.

## Scoring

Each signal receives labels:

- `Hot`
- `Watch`
- `Opportunity`
- `Conversation`
- `Action Today`

It also gets 1-5 scores for:

- Alex / Studio Low Five relevance
- Brand voice product relevance
- Workflow prompt library relevance
- Chain Chasers relevance
- Timeliness
- Content potential
- Business opportunity

Scoring lives in `src/scoring.js`. Tune the keyword lexicons there as the agent learns what matters.

## Deduplication

Deduplication lives in `src/dedupe.js`. It groups by canonical URL first, then by normalized title. When the same story appears in multiple sources, the report keeps one signal and increases its importance through `crossSourceCount`.

## Signal Store Retention

`data/signals.jsonl` is append-only during collection but is compacted at the end of every `collect` run (`compactSignals` in `src/storage.js`): rows are collapsed to one per signal id (keeping the freshest copy) and anything older than `SIGNAL_RETENTION_DAYS` (default 14) is dropped. This keeps the file and the report-time dedupe honest instead of growing forever.

## Connector Health

Every `collect` run writes `data/connector-status.json` with per-source item counts and any errors. The generated report opens with a **Connector Health** section summarizing how many enabled sources reported `ok`, were `empty`, or `failed`. This makes a thin report legible: a quiet market and a broken connector no longer look the same.

## Cadence

The cadence logic is in `src/cli.js` and `src/report.js`.

- Monday-Friday: collect, report, and post.
- Saturday-Sunday: collect only.
- Monday: includes Friday evening and weekend signals and adds `Weekend Catch-Up`.

### Scheduling (Windows)

A `run-daily.cmd` launcher runs `node src/cli.js daily` from the project folder and logs to `logs/scheduler.log`. Register it to run every morning with PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "F:\Codex Sandbox\Morning Brief\run-daily.cmd"
$trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
Register-ScheduledTask -TaskName "Morning Brief" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
```

It runs every day at 7am; the cadence logic (above) handles the weekend collect-only and the Monday catch-up. `-StartWhenAvailable` reruns a missed 7am start once the PC is back on, and `-LogonType Interactive` (run only when logged on) ensures access to the GPU, Ollama, and the Claude CLI.

## Troubleshooting

- Connector failed: run `npm run test:connectors` and check `logs/morning-brief.log`.
- Report is empty: run `npm run collect`, then inspect `data/signals.jsonl`.
- ClickUp Channel failed: verify token, workspace ID, channel ID, or set `CLICKUP_CHANNEL_POST_URL`.
- ClickUp fallback failed: verify `CLICKUP_FALLBACK_LIST_ID` and token permissions.
- Reddit blocked or rate-limited: set a clear `REDDIT_USER_AGENT` in `.env` and reduce `MAX_ITEMS_PER_SOURCE`.
- Reddit still rate-limited: increase `REDDIT_DELAY_MS`. The connector tries `old.reddit.com` RSS first, then `www.reddit.com` RSS; JSON can be enabled with `REDDIT_USE_JSON=true`, but public JSON is often blocked without OAuth.

## Automated vs Manual

Automated in v1:

- RSS
- Reddit
- Bluesky, once `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` are set and sources are enabled
- Product Hunt via RSS
- Optional YouTube RSS
- Local collection, scoring, dedupe, report generation, ClickUp posting/fallback

Manual/fallback in v1:

- LinkedIn
- TikTok
- UDisc

Those can be added to `data/manual-signals.jsonl` until a reliable free source is configured.
