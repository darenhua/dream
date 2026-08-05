# Revision log

Append-only. One dated entry per work-order session: what shipped, deviations from the specs and why, open questions for the next WO.

## 2026-08-04 — WO-0 + WO-1 (branch `revision/wo0-wo1-oracle`, 4 commits)

### What shipped

1. **Timezone fix (pre-WO bug, user-approved).** `todayLocal()` was server-locale while `nowLocal` used the configured `TIMEZONE` (then defaulting to `America/New_York` on an LA machine — two clocks, disagreeing). It now resolves through `getConfig("TIMEZONE")`; default changed to `America/Los_Angeles` per user ("I am in PST now"). Test suite pins `process.env.TZ` to match (bun test otherwise defaults TZ to UTC — which was masking a local/UTC date-math split in `weeklyPlan.test.ts`'s `nextMonday()`, also fixed).
2. **Exact-week fix (pre-WO bug, user-approved — C6).** `currentWeeklyPlanV2` matched `weekOf <= date` unbounded, serving a five-week-old plan as "this week" (stale chain menu into daily selection, false facts into any state read). Now exact-week; no plan for the current week returns null, which the oracle states as the fact.
3. **WO-0.** `reviewFirst` (win rollup + `unreviewedDays`) deleted from weekly/daily context payloads; `record_wins` de-advertised (registered, neutral description, "never part of a planning flow"); `qualityBar` ships `{ plan }` only; `recentDailyPlans` drops run/completion counters (priors, not a ledger); instruction block shrunk to the six global laws + the fenced non-planning RECORD RULES; pick vocabulary, kill-on-sight field mentions, draftKey prose, and inlined rubrics removed from instructions; v1 monthly-template field family cut from `prioritize_context` / `append_plan_doc` descriptions. Acceptance greps clean; suite green.
4. **WO-1.** `services/planningOracle.ts` + `get_planning_context` (additive, 17 tools now). Load → pure interpret → pure render; §4.1 headers; fact-vs-inference marked; refuse-vs-degrade per TARGET §7 (absent parent **routes forward**, never errors — the read tool renders the warm parent-route; hard refusal belongs to WO-2's write path); lateness tiers in exported `ORACLE_CLOCK`; ≤130-word budget test-enforced; no-shame regex swept across the matrix; `structuredContent` dual (no declared outputSchema — SDK 1.29 passes it through unvalidated, avoiding hard-fail on drift). 13 unit fixtures + 2 MCP smoke tests.

### Deviations from the specs

- **Two adjacent-code bug fixes** (items 1–2 above) technically outside WO-0/WO-1 scope; both explicitly user-approved this session and load-bearing for the oracle stating facts.
- **RECORD RULES kept in the instruction block** (fenced as non-planning) though WO-0 says "shrink to six laws": migration §2 keeps the membrane for organized truths, and deleting its rules would break a flow this WO doesn't own.
- **`prioritize_context` kept advertised.** BRIEF C8 + user this session: pick is fully sunset — but it is currently the *only* path to establishing an era; killing it before monthly-create exists strands the system (no era → weekly refuses → nothing works). It dies in WO-3.
- **Oracle opening moves are §6.4/§6.5-*shaped*, not byte-verbatim** — the verbatim templates are playbook spec (WO-3/4/5); the briefing renders the shape.
- **History priors trimmed** (user: "not too important, use judgment"): prior-week chains (the carryover check — core), last-4 weekly themes, last-5 daily themes. Era-agnostic. No deep payloads.
- **Monthly substance pre-WO-3** = adapter (`loadEraSubstance`): theme from group head, story from the monthly plan doc, promises `[]` — never faked from `experiment_idea` rows (anti-path #7).
- **`planStateFor` still ships `stepsDone/stepsTotal`** for the target date's existing plan: kept as update-vs-fresh evidence, not a ledger. Revisit at WO-5.

### User rulings captured this session (bind later WOs)

- **C1/C8 — pick + experiment_group sunset entirely**: "screw pick, we want to completely sunset pick, monthly flow does it all"; monthly should "simply be a monthly plan". **WO-3 is bigger than migration §4 describes**: not group-establishment-inside-monthly-create but a `monthly_plan` table replacing the group/current_focus pair as the planning top horizon (membrane keeps groups only if organized-truths still need them).
- **C3/C4 — data model must change for chains**: 3/3/3 zones must be representable; `zone`, `friendlyCueTitle`, `kind`, `carryover`, `sharedCueWith` all absent today; `links[]` vs `steps[]`+`rewardKind` enum is a different shape. WO-4's "reconcile" is a near-total rewrite of `if_then_chain`.
- **C7 — TARGET §11 "auth resolves the user on every call" is v1 boilerplate**; system is deliberately single-tenant/no-auth. Not building. (Separate security audit of `/mcp` exposure spun off as its own task — `requestPolicy` is fail-open when no hosts are configured.)

### Open questions for WO-2

- Session table: `contextSnapshot` should include the oracle's `structured` output (already shaped for it) — confirm whether the GCal window goes in as raw event list or summarized busy-blocks.
- `begin_planning_flow` intent resolution can reuse `parseIntent` + `resolveDailyTarget` from the oracle — consider exporting a shared resolver rather than duplicating.
- Hard refusals (TARGET §9 voice) belong at begin/save; the oracle's `blockedBy` field is the machine-readable input for them.
- Live-data note: prod/staging DBs may carry a stored `TIMEZONE` config row of `America/New_York` that now shadows the LA default — needs a one-time `setConfig("TIMEZONE", "America/Los_Angeles")` (or dashboard /api/config edit) at deploy.
- Stray `data/dream.db` at **repo root** (Jul 16, wrong location — real dev DB is `backend/data/`): a few test runs this session executed against it from the wrong cwd; contents were wiped by test setup. Believed to be a stale accident, left in place — delete after confirming nothing references it.
