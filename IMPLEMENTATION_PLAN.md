# Dream Rework — Phased Implementation Plan

Companion to REWORK_SPEC.md and SCHEMA_AND_SURVEYS.md (v1.1 corrections
applied: legacy table names kept, single `description` columns).

Ground rules for every phase:
- Verification loop before calling a phase done:
  `cd backend && bunx tsc --noEmit` → isolated `bun test` (scratch DB_PATH)
  → `cd dashboard && bun run build`. (Dashboard `tsc --noEmit` fails on
  pre-existing env-TS-version issues on this VM — the build is the gate.)
- Environment facts (verified 2026-07-20 on this VM): zero env vars needed
  for dev/tests/boot — SQLite auto-creates+migrates at DB_PATH. Needed
  later: ANTHROPIC_API_KEY (or Bedrock creds) for server-side agent runs
  (the AI reconciliation pass); GOOGLE_CLIENT_ID/SECRET + OAuth connect
  for calendar phases 6-7.
- No destructive table drops early: legacy tables/systems we're ignoring
  (witness, strikes, outbox, raw registries) stay in the schema so dangling
  code keeps compiling. We stop feeding them, we don't rip them out.
- Small targeted commits per work item; never `git add -A`.
- Insert-only invariant from Phase 1 on: nothing outside the review apply
  path writes domain rows.

---

## Phase 0 — Demolition (make room, keep it compiling)

Goal: the old creation paths are gone; the app still builds and runs.

- Delete pipeline services + routes + screens: `rantDetection.ts`,
  `distill.ts`, `derive.ts`, `proposals.ts`, `revise.ts`, `projector.ts`
  (derive/review projections), extraction routes/screens (RantExplorer,
  RantCandidatesGate, ExtractionReview, ProposalReview, ProposalLedger),
  candidate-experiment endpoints (`GET /candidates`, `enqueueExperiment`),
  legacy schedule-chat + steer/shaping chat paths.
- Delete the auth ceremony: `collaboration_invite` usage, OTP redemption,
  dashboard capability hashes, companion identity/bearer/loopback,
  peer-address header machinery, redemption rate limiting, the mode system
  (`assertDraftFitsWorkspace` per-mode gating).
- Keep-but-orphan: witness/outbox/strikes/anchors code stays untouched.
  Fix only compile breaks caused by deletions (delete dead call sites, do
  not redesign).
- Done when: build+tests green with the pipeline gone; MCP servers still
  mount (temporarily with their old tools).

## Phase 1 — Schema foundation (migrations only)

Goal: every table from SCHEMA_AND_SURVEYS Part 2 (v1.1) exists.

- Add versioning columns (`lineage_id`, `version`, `prev_version_id`) to
  repurposed tables: `organized_goal`, `habit`, `environment_item`,
  `project`, `experiment_group` (+ backfill `lineage_id = id`, `version=1`
  for existing rows; migrate `parent_experiment_group_id` → `lineage_parent`).
- Create new tables: `lineage_parent`, `conversation_record_link`,
  `pattern_of_behavior`, `goal_pattern`, `experiment_idea`, `idea_goal`,
  `idea_project`, `task`, `group_idea`, `group_habit`, `daily_plan`,
  `daily_plan_item`, `leisure_activity`, `takeaway`.
- Alter repurposed tables: `current_focus` + `end_date` (drop the
  entry_reason/sunset requirement at the service level);
  `experiment_group_goal` + `rank`; `goal_habit` + `description`;
  `experiment` slimmed usage (theme, description, weekly-goal in
  `description`; statuses unused); `experiment_task` repurposed
  (kind todo|intention, done_at); `calendar_event` + `push_status`,
  `completed_at`, broadened entity types; `draft_change_set` +
  `reconciliation_json`, `marker_token`, nullable workspace columns;
  `conversation` pipeline columns dropped; single-`description`
  consolidation on repurposed tables; drop `habit.valence`; replace ALL
  status enums with derived timestamps per SCHEMA v1.2 (retired_at /
  archived_at / done_at / submitted_at / pushed_at etc.); nullable
  `source_conversation_id` on every versionable table.
- Update `wipeAllTables` ordering; regenerate drizzle migrations; schema
  round-trip test.
- Done when: migrations apply cleanly on a fresh DB and on a copy of the
  real DB; tsc green.

## Phase 2 — Review inbox core (the write membrane)

Goal: one generalized path through which ALL domain writes happen.

- Generalize the draft_change_set service: create/save/revise/submit/apply/
  reject-with-feedback, minus workspace/mode. Keep the transactional
  guarded apply + optimistic concurrency.
- New operation vocabulary for apply: insert-only creates for every model,
  version-bump creates (same lineage), remix creates (lineage_parent rows),
  relationship-row creates. Automated lineage propagation (relationships
  reference lineage ids — verify with tests).
- AI reconciliation pass: an agent run over a submitted change set that
  searches existing records per row and writes `reconciliation_json`
  (new | version-bump-of X | remix-of X | link-to-existing X) for the
  reviewer. (Reuses the agentRunner harness.)
- Dashboard: generalized review inbox (adapt CompanionInboxCard +
  DraftReview): shows summary, per-row classification, apply / send-back /
  reject. Raw JSON rendering is acceptable in this phase.
- Done when: a hand-crafted change set round-trips: submit → reconcile →
  apply → correct rows + lineage + links in DB; feedback loop returns it
  to drafting.

## Phase 3 — MCP surface v1 (create + read)

Goal: records can be born from a Claude conversation.

- Single persistent no-auth MCP host (adapt the companion transport:
  sessions, idle pruning, security headers; identity gone).
- `record_create` tool: per-model surveys (SCHEMA_AND_SURVEYS Part 3) in
  tool instructions; produces one change set (central + satellites, FKs
  pre-wired); returns the marker token in its result text.
- `read_record` tool: adapt companion read models (overview, search,
  detail, relations) + load originating conversation slices when imported;
  this is the conversation initializer for branching/enrichment.
- Server instructions rewrite (creation liberality rules, linkage-depth
  invariants, stub-friendliness, evidence rule).
- Done when: live end-to-end: a real MCP conversation creates a goal with
  satellites → review inbox → apply; read_record loads it in a fresh
  thread and a v2 branch submission round-trips.
- Verified via the dry-run harness (MASTER_CHECKLIST "MCP testing"):
  a Sonnet subagent plays the user against the real localhost endpoint;
  a second lightweight reviewer judges the transcript against
  CONVERSATION_FLOWS.md and DB state, suggesting prompt tweaks. Applies
  to phases 5-7 flows too.

## Phase 4 — Conversation import rework

Goal: the provenance spine works.

- Parser reads typed `content[]` blocks (tool_use/tool_result survive);
  retain message uuids.
- Import scans for record_create marker tokens → writes
  `conversation_record_link` rows (slice_end_idx = marker message index);
  backfills links for records created before import.
- read_record serves record + slice text.
- Done when: import of a real export containing an MCP creation stitches
  the slice; re-import stays idempotent.

## Phase 5 — Groups + prioritize (monthly level)

Goal: ideas → groups → one picked focus with a deadline.

- Group creation through record_create: membership (`group_idea`),
  bad-habit links (`group_habit`), goal set seeded as union of member
  ideas' `idea_goal` links then curated in conversation →
  `experiment_group_goal` with rank.
- `prioritize` MCP tool: reads candidate groups + goals + descriptions;
  brainstorm-style conversation; produces a pick change set →
  `current_focus` with `end_date`; expiry re-arms (no sunset ceremony).
- Group branching: read_record on an expired pick's group → v2/remix
  change set.
- Habit materialization hooks: pick apply may create system habits
  (origin=system, active_experiment ref) — scheduling still deferred.
- Done when: full monthly loop on a seeded DB: create ideas/goals → group
  → pick with deadline → expiry → branch to v2 → re-pick.

## Phase 6 — Weekly plan

Goal: the weekly conversation, minimal scheduling, momentum chain.

- `experiment` as weekly plan: theme + description (weekly goal);
  `experiment_task` as todo|intention items with done_at.
- `weekly_plan` MCP tool: reads current focus, group ideas + done-states,
  ALL prior weekly plans of this focus, completion data, deadline
  (weeks-remaining pushback), leisure table; converges; change set →
  review.
- Scheduling: habit blocks + anchored tasks only → `calendar_event` rows
  with push_status → GCal push on week start (materialization timing rule).
- Group idea done-flow: dashboard CRUD on `group_idea.done_at`;
  next weekly reads it.
- Done when: two consecutive weekly plans where week 2's conversation
  demonstrably builds on week 1's items/completions; calendar rows push.

## Phase 7 — Daily plan + calendar heavy-lifting

Goal: the daily conversation and the ad-hoc scheduling engine.

- `daily_plan` + `daily_plan_item` flows; manual done CRUD in dashboard
  (doubles as habit signal).
- Calendar writer consolidation: one service for bulk ad-hoc event
  creation (idempotent, throttled, push_status lifecycle); GCal
  source-of-truth read path (busyByDate reuse); daily events (blocks,
  leisure, invented reminders).
- `daily_plan` MCP tool: current weekly plan + last ~7 dailies + open
  tasks (deadline-filtered, daily nag for unanchored) + leisure +
  takeaways + calendar; fixed question set (energy/social/work); work
  context standing record; conversation-confirm writes events directly
  (lighter review — per spec decision).
- Done when: a daily plan lands real events on GCal including leisure and
  invented blocks; next-day plan reads completions.

## Phase 8 — CUT (was: rant MCP + takeaways)

The rant MCP and takeaway table are out of scope (spec §8a). Venting =
read_record-initialized conversations. Daily plans record reported state
(energy/social/work) in their description; successor plans read it.

## Phase 9 — Dashboard rework (needs user input on views)

- Three-level view: current focus (theme, deadline, goals + why chosen,
  relevant patterns), current weekly plan (theme, items, done CRUD),
  today/tomorrow daily plan (theme, blocks, done CRUD).
- Record browser with lineage (version chains, branch trees), provenance
  (conversation slices), review inbox polish (real classification
  rendering instead of raw JSON).
- Delete dead screens/cards; rename user-facing "organized" language.
- Shape (decided): main page = current-state display only (pick, weekly,
  daily, goals + why chosen + patterns, completion CRUD); approvals/review
  inbox on a SEPARATE page. Fine-grained layout still open.

## Sequencing notes

- Phases 0-1 are mechanical; 2-3 unlock everything (first usable loop:
  create + review + read). 4 can overlap 5. 6-8 are the daily-life value.
  9 last, after views are specified.
- After each phase: update REWORK_SPEC/SCHEMA docs if reality diverged.
