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

## 2026-08-04/05 — WO-2 through WO-6 (same branch, continued session; user directive: "keep going until the ideal mcp state is reached")

### What shipped (3 commits: prompt pack, WO-2/3/4, WO-5/6)

The full 3-tool surface is live end-to-end: `get_planning_context` →
`begin_planning_flow` → `save_plan`, 14 tools total (3 planning +
current_task_context + read/append_plan_doc + record_wins unadvertised +
7 membrane). 134/134 tests green; live smoke of the whole
monthly→weekly→daily loop verified.

- **Prompt Pack v1** committed as `docs/revision/PROMPT_PACK.md` (canonical
  string source) with a session addendum listing the retrofit steps — all of
  which then landed: GLOBAL.v1 instructions, TOOL.*.v1 descriptions verbatim,
  BRIEF.skeleton.v1 briefing shape, version stamps
  (`playbookVersion`/`briefingVersion`).
- **WO-2**: `planning_flow_session` (24h TTL + refresh, lossless expiry,
  sibling auto-cancel, context snapshot incl. calendar window as dated data);
  save pipeline with request_id idempotency, `user_confirmed_save`, revision
  → conflicted; all §7 ERR strings + RCPT.saved.v1.
- **WO-3**: `monthly_plan` table (era periods, theme/subline/story, promises
  JSON with provenance/addedAt, revision, supersede). Promise subtraction
  rejected as walk-back; periodStart immutable; era shrink refused. Oracle
  reads monthly_plan first; the legacy pick adapter remains only as fallback
  for pre-migration data.
- **WO-4**: chains extended (zone, friendlyCueTitle, kind, sharedCueWith,
  era home; group lineage nullable); era chains store links as steps so
  runs/NowBoard/GCal/auto-wins are untouched; weekly artifact per TARGET §8
  with per-zone ≤3 replacing the global cap (overflow surfaces verbatim);
  carryover on the join row; weekly update = supersede (old row + links +
  daily pointers survive).
- **WO-5**: daily = date + theme + selectedChainIds. Killed columns DROPPED
  (top_priority, supporting_*, first_domino, minimum_viable_day,
  parking_lot_json, draft_key); rubric.ts deleted; API + NowBoard slimmed;
  grep-clean verified.
- **WO-6**: five old tools removed; v2 services reduced to shared reads;
  trajectory tests = the 3-call flow; template-verbatim tripwire tests (W44 +
  ECHO byte-identity, GLOBAL law anchors, kill-vocabulary sweeps); eval seeds
  in `test/fixtures/planningEvals/`.

### Deviations + judgment calls

- **One session for WO-2..6** against REVISION_WORKFLOW's one-WO-per-session
  rule — explicit user directive. Template protection was delegated to the
  byte-identity tests rather than fresh-context discipline.
- **Monthly update mutates in place (revision++)**; supersede reserved for
  create-over-existing (deferred — create refuses when an era is active).
  Weekly/daily updates supersede (insert new row) per evidence laws.
- **Era chains reuse `if_then_chain` + steps** (links → starter/core steps,
  reward step last) instead of a new table — preserves NowBoard, runs,
  auto-wins, GCal blocks with zero migration of run history. v2 canonical
  shape + ACTIVE_CAP now apply only to legacy group chains.
- **Recurring/maturing set** = prior weeks' `carryover: "continued"` chains
  (migration §5's minimum-viable derivation). Lifecycle proper still future.
- **Daily arming carries no times** → no GCal cue block from the minimal
  daily (artifact has no scheduling by R2). R5 behavior preserved at the
  armChain layer; blocks return when a scheduling surface exists.
- **weekly_plan.current_focus_id made nullable** (era rows have no pick);
  legacy v2 columns (direction, topOutcomes, …) kept as dormant history.
- **Monthly-create with an active era refuses** (update or explicit
  supersede later); "era supersede" flow is an open design for a future WO.
- **`{{tension_1}}` in the monthly-create opener** still renders "(none on
  file)" — the records-derived tension read needs a loader that doesn't
  exist yet. Open.
- **Dashboard**: NowBoard/api.ts trimmed of dead fields only; dashboard has
  19 PRE-EXISTING tsc errors (ReviewInbox RecordOperation types) untouched.
  A richer era/weekly dashboard read of the new tables is future work.

### Open questions / next steps

- Claude connector re-point + staging soak + trial round 2 (WO-6's last
  acceptance item — needs the user).
- Prod data: one-time `setConfig("TIMEZONE", "America/Los_Angeles")`;
  existing pick-era data keeps working via the fallback adapter until the
  first real monthly_plan is saved.
- Eval bench: fixtures seeded; the LLM-judge harness itself is unbuilt.
- Legacy services (prioritize pick flow via membrane, weeklyPlan v1,
  dailyPlan v1 items) still exist for organized-truth/history paths — a
  later sweep can retire what nothing reads.
