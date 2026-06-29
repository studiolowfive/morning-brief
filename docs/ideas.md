# Outstanding ideas / backlog

Quality and capability ideas not yet built. Ordered roughly by impact.

## Voice calibration (POCKETED — tackle later)
Feed the polish step a handful of Alex's *real* posts/LinkedIn lines as voice
exemplars, so suggested angles sound like Alex, not "a generically contrarian
marketer." The angle/LinkedIn sections are only valuable if usable as-is; the gap
between "a sharp line" and "a line I'd actually post" is voice fidelity.

**How:** add `config/voice-samples.md` (5–10 real Alex lines); include in the
polish prompt as "match this voice." Compounds with the feedback loop — curate
the samples over time. Cheap to add.

## Verbatim audience language
For each signal, surface the *actual words* real people used (pulled quotes), not
just the model's paraphrase — raw material for copy/positioning. Also fix
`audienceLanguage()` in report.js (emits near-duplicate title + title-prefixed
summary lines).

## Roles & Gigs section (requested)
Add a line or two to the brief recommending roles/contracts Alex could apply for
or pitch (contract strategy, copywriting, etc.) — surfaced from the day's signals
(hiring posts, "looking for help with…", freelance asks) and matched to a
capability profile. Needs `config/professional-profile.md` (hireable skills, role
preferences, rates/availability). Note: Alex's capabilities live in a claude.ai
"professional development" Project, which Claude Code cannot access — get the
profile via paste, a local file, or Google Drive instead. Optional follow-on:
add dedicated job/gig RSS sources to actively hunt rather than only surface what
appears on Bluesky.

## Cross-day momentum
Persist what's been surfaced so trending stories don't repeat and the brief can
say "AI-slop discourse is accelerating — day 3" vs. "isolated complaint." Knowing
something is building vs. fading changes the angle.

## Insight → draft
Generate ready-to-edit drafts (a LinkedIn post, a specific thread reply) from the
top signals, so it's one edit to publish instead of a blank page.

## Delivery beyond ClickUp
Glanceable morning format (top 3 + collapsed rest), and/or email digest or short
TTS audio version.

## Heartbeat / health alert
When unattended and a run fails or sources degrade, ping Alex — don't rely on the
health section of a brief he might not open.
