# Deferred: nightly "plan tomorrow" + morning card

*Status: consciously deferred (2026-07-14). Do not half-build this — the value is the act of choosing, and a faked auto-generated card would be worse than nothing.*

## What it was

A nightly ritual (≤5 min hard budget) that turns tomorrow from a default day into an intentional one:

- **Trigger** anchored to an existing night habit; pre-drafted plan generated from active goals, live experiment state, tomorrow's free time, open tasks, the day's rants — the user edits, never composes.
- **Fast path**: one-tap "accept as-is" under 60 seconds (the primary path). **Conversation path**: ≤5 min L3 chat to adjust. **Explicit skip**: 5 seconds, optional one-line why — a conscious "not tonight" is presence, not failure.
- **Outputs in degrade order**: (1) the **morning card** — attitude-of-the-day (identity-framed, e.g. "Wednesday is a risk day"), exactly ONE mini goal (concrete uncomfortable action tied to the live experiment), its when-then anchor, one line from last-night-you; (2) todo tasks; (3) Google Calendar writes.
- **Delivery**: pinned at the top of the dashboard until noon. No push to the user, ever.

## Why it was deferred

The original doc justified it partly as "a daily heartbeat the tripwire can listen to." The derived vitals killed that job: the system already hears every export, accept, confirm, ratify, and experiment transition (SPEC amendment 15). What remains is the genuine product — *waking up to intention* — and the user said plainly the value is in the **planning act itself**, which deserves its own build, not a stub.

## If/when it gets built

- It is a **standing commitment**: it passes through an explicit consent moment once (a config flag + a consent card is enough — no new proposal kind).
- Storage question already settled in brainstorm: no `tomorrowPlan` table — it is a `chat_session` purpose (`plan_tomorrow`) with a `forDate`, pre-draft seeded as the first assistant message, accept = confirm (a zero-turn conversation most nights), skip = cancel + note; the morning card renders the committed artifact.
- An explicit skip counts as engagement. Missed-plan strikes only ever made sense paired with the ritual's consent — revisit against the derived clocks then.
