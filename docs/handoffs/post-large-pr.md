# Handoff: after the MCP-rework PR (#6)

*Written 2026-07-22, the day PR #6
(`codex/mcp-rework` → `main`, merge commit `92dfb23`) merged. This is the
orientation document for whoever (human or agent) picks up the next phase.
Reading order for the whole docs set: see
`docs/handoffs/agent-onboarding-prompt.md`.*

## 1. What the merged PR implemented

The rework replaced the old ambient pipeline (rant detection → distillation
→ derivation → proposals) with intentional conversational record creation.
Phase by phase:

- **Demolition:** the extraction pipeline, legacy chat surfaces, and dead
  dashboard screens were deleted. Some legacy services remain in-tree but
  dormant (see §3).
- **Schema foundation** (migrations `0019`, `0020` — additive + backfill):
  versioning columns (`lineage_id`, `version`, `prev_version_id`,
  `source_conversation_id`) spread onto five repurposed tables; 13 new
  tables (lineage_parent, conversation_record_link, pattern_of_behavior,
  experiment_idea, task, group/idea/habit link tables, daily_plan,
  daily_plan_item, leisure_activity, …); calendar push-bookkeeping columns;
  draft_change_set repurposed as the review-membrane row.
- **The write membrane:** `record_create` change sets (one central +
  satellites + links with temp refs) → review inbox → AI reconciliation
  (new / version_bump / remix / link_existing; Anthropic API or Bedrock via
  `USE_BEDROCK`) → transactional apply with human verdict overrides;
  revise/reject round-trips under a stable marker token.
- **Reads:** `list_records` (cross-model search) → `read_record` (typed
  relation web, version chain, parents/children, and the originating rant
  inlined) — reading is an explicit two-step user act.
- **Provenance:** marker tokens `rc_<12hex>` in tool results; conversation
  import stitches exports to applied records bidirectionally
  (import-then-apply and apply-then-import both heal).
- **Planning:** monthly pick (`prioritize_context` + pick op), weekly plan
  (`create_weekly_plan` op with habit materialization), daily plan
  (`create_daily_plan`, direct write) — all writing calendar events through
  the async write-job queue with best-effort push + heartbeat retry.
- **MCP:** 11 tools, no auth, Streamable HTTP at `/mcp`, server
  instructions rules 1–11, per-model surveys, operation contract.
- **Dashboard:** PlanBoard home (pick/weekly/daily + records browser),
  Review Inbox page, admin panel (import, calendar, heartbeat, danger
  zone).
- **Verification:** 84 tests passing at merge; a live MCP dry-run harness
  (Sonnet subagent plays the user, reviewer subagent judges the transcript)
  passed all 7 conversation rules — recipe recorded in
  `MASTER_CHECKLIST.md`.

Authoritative design docs, still at repo root, in authority order:
`REWORK_SPEC.md` → `SCHEMA_AND_SURVEYS.md` → `CONVERSATION_FLOWS.md` →
`IMPLEMENTATION_PLAN.md` (as-built status header) → `MASTER_CHECKLIST.md`.

## 2. Load-bearing architecture decisions

Each of these was argued out explicitly; don't relitigate them casually.

1. **Insert-only versioning; relationships on lineage ids.** No update
   writes anywhere. Because lineage ids are not unique across version rows,
   relations CANNOT have DB foreign keys — that's deliberate, and it's what
   makes version bumps propagate for free.
2. **No status enums.** State is derived: timestamps (`retired_at`,
   `done_at`, `ended_at`, `pushed_at`, …), deadline math, and
   latest-version-of-lineage. (One legacy exception: `applyPick` maintains
   the old `current_focus.status` column solely for the one-current unique
   index.)
3. **Legacy table names kept** (`organized_goal`, `experiment` = weekly
   plan, `experiment_task`, `current_focus` = monthly pick,
   `experiment_group_goal`, …). Renames against a live prod SQLite were
   judged not worth the risk. The ugly names are permanent until decided
   otherwise.
4. **Single `description` column** per record — no `why_md`, no
   multi-markdown fields. Whys live on link descriptions, near-verbatim in
   the user's words.
5. **Prompt-first calendar reads.** Availability comes from the user's
   external Google Calendar MCP by *instruction* (rule 11), not from
   Dream-side plumbing. Daren explicitly rejected building live-read
   machinery: "don't reinvent the wheel." `busyByDate`/`freeTime.ts` exist
   but planners deliberately don't use them.
6. **`calendar_event` rows are async write jobs**, never availability;
   push is best-effort and capped; the daily heartbeat retries failures.
7. **Daily plans skip the review inbox** — the conversation is the review
   (spec §8a). Everything else goes through the membrane.
8. **Marker token format `rc_<12hex>`** is a stability contract: it must
   survive chat-export parsing (`MARKER_PATTERN` in `provenance.ts`).
9. **The MCP has no auth** (single user, personal system) — a deliberate
   product call, revisit only alongside the environments work.

## 3. Known rough edges

- `z.string().datetime()` in plan inputs **rejects offset timestamps**
  (`…-04:00`); agents must send raw Z times today. Backlog CAL-3.
- Timestamps are stored/pushed as raw Z; **04:15Z is 12:15am ET** — a
  real-world confusion trap until CAL-3 lands.
- Failed calendar pushes wait for the **daily heartbeat** sweep; the
  dashboard "sync now" is inbound-only (backlog CAL-1) and push state is
  invisible in the UI (CAL-2).
- **Dashboard `tsc --noEmit` fails** on pre-existing environment/TS-version
  issues (baseUrl deprecation, css side-effect import). `bun run build` is
  the dashboard gate. Do not chase those tsc errors.
- **Google OAuth binds whichever account approves consent** — not the
  client ID. Caused a prod incident (events on the wrong account's
  calendar). Fix ritual: disconnect (deletes the `google_auth` row incl.
  the cached dream-calendar id), reconnect in an incognito window with the
  right account.
- **Dormant legacy code** still in tree: `extractions.ts`, `experiences.ts`,
  `witnesses.ts`, `outbox.ts`, `strikes.ts`, `dutyPings.ts`,
  `witnessScope.ts`, `freeTime.ts`, chat/collaboration tables, and several
  API routes serving the old feed. Dormant ≠ dead: the accountability work
  (backlog ACC-*) plans to revive witnesses/outbox/strikes.
- Root `deployment.md` mixes still-true VM/ops facts with a description of
  the deleted pipeline; `RECAP.md` §deployment holds older VM recon.
- Observed agent-behavior gaps are catalogued as backlog MCP-1…MCP-8 —
  the biggest: premature writes without echo-back (MCP-1).

## 4. What should NOT be casually rewritten

- **Applied migrations** `backend/drizzle/0001…0020` — never edit; prod has
  run them. New schema work = new migrations, additive-only.
- **The lineage/versioning invariants** and the no-FK-on-relations choice.
- **The change-set op vocabulary** (`create` / `link` / `pick` /
  `create_weekly_plan`) and the one-central-per-set rule — the MCP, the
  validators, the reconciler, and the review UI all speak it.
- **The marker token format** and `MARKER_PATTERN` — breaking it orphans
  every past conversation export.
- **Legacy table names** — renames are a decided non-goal.
- **The review membrane flow** (submit → reconcile → human verdicts →
  transactional apply) — extend it (MCP-3/4/5), don't bypass it.
- **Server instruction rules 1–11** — tighten wording freely (that's most
  of the MCP backlog), but each rule encodes a user decision; don't drop
  one without checking the product doc.

## 5. Recommended order for the next phase

Governing directive: *"I don't JUST want actual fixes, I want groundwork
laid so that this fix and future fixes are easier."* So:

1. **Ship infrastructure first** (INFRA-1…6): scripts library + snapshots,
   staging beside prod, staging auto-deploy, prod tagged deploys, dev
   parity. Everything after this gets cheaper and safer. Note: VM-side
   steps must be packaged as scripts + a runbook for Daren — coding
   sessions cannot reach the deployment machine.
2. **Agent access to environments** (env-and-delivery §5 + decision MCP-7):
   admin/inspection MCP, staging-first workflow, prod read safety.
3. **The friction→tickets pipeline** (MCP-9) — it turns real usage into the
   future backlog and wants the safe environments from steps 1–2.
4. **MCP behavior fixes** (MCP-1, MCP-2, MCP-8 first — all instruction-layer
   and testable with the dry-run harness; then MCP-3/4/5/6).
5. **Planning product** (PLAN-1 themes, PLAN-2 leisure/bandwidth, then
   PLAN-3/4/5/6) and **calendar smalls** (CAL-1/2/3).
6. **Accountability** (ACC-1 recaps first — the stated primary) — needs the
   messaging-transport decision (`docs/messenger-local-switch.md`).
7. **Dashboard UX** (DASH-1/2/3) — anytime; pairs well with INFRA-5's seed
   fixtures for realistic long-text testing.

## 6. How to verify anything

```
cd backend && bunx tsc --noEmit
tmpdir=$(mktemp -d); cd backend && DB_PATH="$tmpdir/dream.db" bun test   # scratch DB — tests wipe tables
cd dashboard && bun run build                                            # the dashboard gate (NOT tsc)
```

For MCP behavior changes, additionally run the dry-run harness from
`MASTER_CHECKLIST.md`: boot the server on a scratch DB, have a subagent
play the user against `/mcp` per a scripted scenario, and have an
independent reviewer subagent judge the transcript against the conversation
rules — then verify the DB state matches what the conversation promised.
Bun everywhere (`bun` / `bunx` / `bun test`); see `backend/CLAUDE.md`.
