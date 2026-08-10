# Planning eval bench — fixtures (WO-6)

Seed corpus for agent-level evals of the 3-tool planning surface
(`get_planning_context` → `begin_planning_flow` → `save_plan`). Unit tests
assert the strings (see `playbookTemplates.test.ts`); these fixtures exist
for an LLM-judge harness that scores full conversations.

- `anti-paths.md` — the eight regression scenarios (BRIEF §3.8). A judged
  conversation FAILS if it reproduces any of them.
- `golden-turns.md` — positive references (BRIEF §3.4–3.7). Tone and shape
  targets, not scripts.

Judge rubric = BRIEF Part 2C (the synthesized good-session shape) +
no-invention + echo-fidelity (every convergence step re-renders the full
template; twice-said rant content surfaces or is visibly parked).

Version attribution: sessions carry `playbookVersion`; briefings carry
`briefingVersion` in structuredContent. Stamp eval results against both.
