# Reddit Data API access request — reference answers

Morning Brief reads public subreddit listings via the Reddit Data API. As of the
2025 Responsible Builder Policy, new API access requires pre-approval through the
Data Access Request form (role: **developer**; inquiry: *"I'm a developer and want
to build a Reddit App that does not work in the Devvit ecosystem"*).

These are the reference answers used for the application. Keep everything pointed
at: personal, read-only, low-volume, not redistributed, not used to train models.

## What benefit/purpose will the bot/app have for Redditors?

This is a personal, read-only tool, so it has no direct user-facing feature for
other Redditors and never posts, comments, votes, or messages. Its benefit is to
me — it helps me stay current on discussions in communities I follow. It is
deliberately built to be a low-impact, well-behaved API client: a few read
requests per day, well within rate limits, with no automated interaction that
could affect anyone else's experience on the platform.

## Detailed description of what the Bot/App will be doing

The app runs locally on my own computer once or twice a day. Using OAuth (a
"script"-type app authenticated as my own account), it fetches the public "hot"
post listings from a small fixed set of subreddits, then scores and summarizes
them locally into a private brief I read myself.

Example flow: each morning it requests the hot listing for r/copywriting (and a
few others), receives the listing JSON, extracts post titles, summaries, scores,
and comment counts, filters out low-signal/promotional items, and writes a short
summary to a local file and a private task in my own ClickUp workspace.

It is strictly read-only: it never posts, comments, votes, messages, or modifies
anything on Reddit. Volume is very low (a handful of requests per day). Collected
data stays in a local rolling cache on my machine — never redistributed,
published, sold, or shared, and never used to train any machine-learning or AI
model.

## What is missing from Devvit that prevents building on that platform?

Devvit builds experiences that run inside Reddit on Reddit's own infrastructure
(interactive posts, community and mod apps). My app runs externally on my own
machine, reads across several unrelated subreddits, and integrates the results
into my own local tools (a Markdown brief and my private ClickUp workspace).
Devvit does not support an off-platform, read-only client that aggregates public
listings and exports them to my own systems, so the public Data API is the only fit.

## Subreddits

r/copywriting, r/Entrepreneur, r/discgolf, r/IndieGaming

## After approval

1. https://www.reddit.com/prefs/apps → create app → type **script** → redirect URI `http://localhost:8080`
2. Copy the client id and secret.
3. Fill `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` in `.env`.

The Reddit connector (`src/connectors/reddit.js`) already prefers OAuth and will
use these automatically.
