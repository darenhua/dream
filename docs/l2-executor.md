# Later build: the L2 executor

*Status: designed, not built (2026-07-14). This is the fourth AI level's missing tier — see SPEC amendment 12.*

## What it is

A tool-using agent for **dynamic tasks on the user's behalf**: Google Calendar reads/writes, database CRUD, eventually web. The flow is always the proposal membrane, generalized:

1. Kick off a job from the dashboard (one prompt of execution instructions).
2. The agent **plans** and presents a concrete step list of intended writes — "create experiment X, 4 tasks, 2 habits, 6 calendar blocks Tue/Thu 7am" — never a vibe.
3. The user approves in the dashboard.
4. The agent executes, results logged (an `executor_task` table: prompt → planned steps → awaiting_approval → executing → done/failed).

## Laws

- **Unattended work can never be L2.** The heartbeat and all cron work stay deterministic code or L4 — the agent with the pen only moves while the user is watching. This is structural (approval requires a human at the dashboard), keep it that way.
- Routine paths stay deterministic: commit-plan materialization, gcal pushes, witness broadcasts run unattended and must never depend on token weather. L2's niche is the **long tail** — ad-hoc, one-off operations not worth a dedicated code path ("reshuffle next week around the trip", "archive everything touching goal X").

## First job

The **experiment writer**: an L3 shaping writeup (already built — `experiment_shaping` sessions) as input → L2 proposes the concrete experiment/task/habit/calendar writes → approve → execute. Once that works, migrating the schedule chat to the L3→L2 pattern retires `runChatTurn`'s structured-plan hybrid.

## Engine candidates (spike before committing)

- **Claude Agent SDK** — full harness; prerequisite: verify it runs under Bun with Bedrock (the concern that produced SPEC amendment 9).
- **Vercel AI SDK tool loop** (`generateText` + `tools` + steps) — already a dependency since the witness build, zero Bun risk, hand-rolled approval gate.

Context strategy: small context inlined RAG-style; large context via the existing projector workspace (files written to disk, linked into the prompt) — the box-and-link mechanism already exists.
