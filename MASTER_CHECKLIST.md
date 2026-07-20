# Dream Rework — Master Requirements Checklist

The compaction-proof ledger: every requirement from the design conversation,
one line each, with its home document. If a future session remembers nothing
else, it must honor everything here. Docs (authority order: later
corrections supersede earlier text): REWORK_SPEC.md (+§8a addendum) →
SCHEMA_AND_SURVEYS.md (+v1.1/1.2/1.3 corrections) → CONVERSATION_FLOWS.md →
IMPLEMENTATION_PLAN.md.

## Paradigm
- [ ] No automated extraction; distill/derive/proposals pipeline deleted. (SPEC §1)
- [ ] Records are created ONLY via record_create, intentionally, from conversation. (SPEC §1, §5)
- [ ] The organized dashboard is the only dashboard; "organized goal" is just "goal" (legacy table names kept, code naming modernized). (SPEC §1, SCHEMA v1.1)
- [ ] Records must be self-sufficient for planning; planners NEVER read rant threads — only read_record does. (SPEC §1, §5 matrix)
- [ ] System purpose: remind me who I am, who I want to be, how to get there sustainably — culminating in literally scheduling my days, including breaks I won't schedule myself. (SPEC §1)

## Write mechanics
- [ ] Insert-only everywhere; zero UPDATE writes on domain data. (SPEC §2)
- [ ] Every create passes the dashboard human-in-the-loop review. (SPEC §2)
- [ ] AI reconciliation pass classifies every row: new | version bump (same lineage v+1) | remix/branch (new lineage, parent links; multi-parent = combine) | link-to-existing (invented FK records deduped against DB). (SPEC §2)
- [ ] Update-vs-remix distinction: more info about the same thing = version; derived-but-new (series from a piece, spin-off, combination) = remix. Agent announces its reading; reviewer is the second check. (SPEC §2, FLOWS E)
- [ ] Stubs are legitimate v1s: goal rants allude liberally; focused threads branch and mature them (the allusion → read_record → expand → v2 flow). (SPEC §2)
- [ ] Relationship rows reference LINEAGE ids → version bumps propagate automatically; never agent work. Time-layer records pin version ids. (SCHEMA Part 4 #1)
- [ ] Every versionable table: id, lineage_id, version, prev_version_id + nullable source_conversation_id (stamped automatically at apply, backfilled at import). (SCHEMA v1.2 #3)
- [ ] NO status enums on domain records — state derives from timestamps + lineage (retired_at/archived_at/done_at/ended_at; current = lineage head; expired = now past deadline). Applies to draft_change_set (submitted_at/applied_at/rejected_at) and calendar push (pushed_at/push_failed_at). (SCHEMA v1.2 #5)
- [ ] Plans have NO success/failure state ever; the next plan just reads its predecessor + completion data. (SCHEMA Part 4 #5)

## Conversation linkage
- [ ] Conversations imported from Claude export zip (existing path); parser must read typed content[] blocks so MCP markers survive. (SCHEMA Part 1)
- [ ] record_create returns a marker token; import stitches slice = everything before the call message (conversation_record_link: slice_end_idx, role central/satellite/mentioned). (SPEC §3)
- [ ] Records exist before their thread text imports; links backfill at import. (SPEC §3)
- [ ] Multiple record_create calls per thread; one call = one change set = central + FK satellites pre-wired (all-in-one; single-record is the degenerate case). (SPEC §5)

## Data model (see SCHEMA Part 2 + corrections for columns)
- [ ] Information side: goal (hub; description = what it means to me), pattern_of_behavior (ONE description covering trigger/emotion/coping/loop; pointer on goal via goal_pattern), habit (two origins: conversation = almost always bad, born as stubs in goal rants; system = being established, born from picks; no valence, no status), environment (conversation origin REQUIRES habit FK — purpose is making a habit easier/harder; calendar origin = standing GCal events, never from conversation), leisure_activity (description carries feeling-pairing in plain text; pattern FK is provenance only), conversation.
- [ ] Ambition side: experiment_idea (volatile, one-liner ok; idea_goal carries the WHY in my words), project (long-running; reaches goals via ideas; many ideas per project), task (one-off; deadline_date; ≤1 idea; idea presence = goal-minded, absence = plain errand).
- [ ] Everything may dangle; linkage is earned in conversation, never forced. Linkage-depth invariants for goal-rant satellites: environment only via habit (2 hops), task/project only via idea. (SPEC §4)
- [ ] experiment_group: theme + description; built by branching/combining ideas; group_idea membership (separate from idea's permanent goal links) carries campaign done_at; group_habit = bad habits being eliminated; goal set seeded as UNION of member ideas' goal links then CURATED in conversation → experiment_group_goal with rank. (SCHEMA, Part 4 #2)
- [ ] current_focus (the pick / monthly plan): pinned group version, reasoning description, started_at, END_DATE (deadline), ended_at; one current at a time; expiry re-arms prioritize; no sunset ceremony. (SCHEMA)
- [ ] Weekly plan = legacy experiment table slimmed: current_focus_id FK (NOT just group — groups recur across re-picks; week N of M derives from it), week_of Monday, theme, description (weekly goal + reported state); experiment_task repurposed as items kind todo|intention with done_at. (SCHEMA v1.1/v1.3)
- [ ] daily_plan: date, theme (work one-liner), description INCLUDING reported state (energy/social/work answers) so successors read it; daily_plan_item (block|todo|leisure, refs, done_at) — manual dashboard CRUD doubles as habit tracking. (SCHEMA v1.3)
- [ ] calendar_event: Google Calendar is SOURCE OF TRUTH; local rows are bookkeeping (pushed_at/push_failed_at); entity types habit|task|weekly_item|daily_adhoc|leisure; completed_at.
- [ ] Habit materialization: idea (plaintext, NOT in habit table) → grouped → PICKED (pick holds FK to new system-habit) → calendar events created ONLY when the weekly plan establishing it begins (habit-row-at-pick is the acceptable compromise; scheduling timing is the hard rule). (SPEC §6)

## MCP surface (five commands, NO auth ceremony — no codes, no OTP, no identity)
- [ ] record_create: digest-EVERYTHING-in-thread is universal (any thread kind); DB search proposes FK candidates from my own records; whys captured near-verbatim; ≤2-3 decision-critical questions per turn; answered questions ≠ go-ahead — explicit yes before the call; "submitted for review" never "created"; per-model surveys per SCHEMA Part 3. (FLOWS rules)
- [ ] read_record: EXPLICIT user act only ("pull down my goal X") — the agent never reads uninvited; list-first when I don't remember the record; per-type pull-downs (goal→habits/patterns/ideas+whys/groups; group→members+done+goal set; project→ideas; task→calendar items+deadline+idea; idea→goal links/memberships); conversation slices = second-level zoom-in on request. (SPEC §8a, FLOWS E)
- [ ] prioritize: runs when no current pick; reads ALL candidate groups + goals + attached context; echo-back brainstorm style (reflect → I rant → organize); ends with one group + end_date + ranked curated goal set + reasoning in my words. Expiry without success → branch group to v2 picking up where it left off. (FLOWS F)
- [ ] weekly_plan: opens with state of play — week N of M, deadline clock, last week's completions, big-ticket position — THEN capacity/readiness questions; theme; items todo|intention; schedules ONLY habit blocks + must-anchor tasks (negotiated); everything else noted, not scheduled; deadline-aware pushback ("3 weeks left — ok failing this week?"); momentum/stack-wins: start tiny, build up (tell friends → playlist → throw party); reads ALL prior weeklies of this pick; next week planned ~2 days before expiry (overlap supported); dashboard review. (FLOWS G)
- [ ] daily_plan: reads current weekly ONLY (not past weeklies) + last ~7 dailies + open tasks (deadline-filtered; unanchored deadline tasks nagged DAILY) + leisure + calendar (GCal truth); fixed question set v1: energy / social urge / work heaviness (editable prompts later); work-life standing context record; theme one-liner tied to work; schedules A LOT including invented blocks (make-breakfast, 1pm walk, 3pm ask-boss note) and leisure matched to reported state; IN-CONVERSATION CONFIRMATION IS THE REVIEW — writes events directly; no out-of-conversation/background writes ever. (FLOWS H)
- [ ] Rant MCP: CUT. Venting = read_record conversation. Takeaway table: CUT (daily plan description carries state). (SPEC §8a)
- [ ] Planner read-scope: whys/motivations feed ALL THREE planners; patterns of behavior + bad habits are NOT read by planners; leisure IS read by weekly + daily. (SPEC §5 matrix + §8a)

## Dashboard
- [ ] Main UI: simply displays the current state — active pick (theme, deadline, goals + what they mean to me + why chosen, relevant patterns), current weekly plan (theme, items with done CRUD), daily plan (theme, blocks, done CRUD), experiment groups. (SPEC §9)
- [ ] Human-in-the-loop approvals UI on a SEPARATE page: the review inbox with per-row classification (new/version/remix/link-to-existing), apply / send-back-with-feedback / reject. (SPEC §9)
- [ ] Manual completion CRUD on daily/weekly items is the completion-tracking + habit-signal mechanism. (SCHEMA Part 4 #5)

## Scope guards
- [ ] Witness/outbox/strikes systems: leave dangling, ignore entirely, keep compiling. (SCHEMA Part 4 #3-4)
- [ ] Experiences: not a model. Editable planner prompts: later, fixed set first. Context windowing rules enforced (daily: current weekly + ~7 dailies). (SPEC §7)
- [ ] Legacy table names kept (organized_goal, current_focus, experiment, experiment_task, calendar_event, draft_change_set...); single description column per table — no multi-markdown fields, no why_md naming. (SCHEMA v1.1)

## MCP testing & review strategy (lightweight, from Phase 3 on)
- [x] FIRST DRY RUN EXECUTED (2026-07-20): goal-from-rant flow driven by a
  Sonnet subagent against the live localhost endpoint; reviewer subagent
  verdict PASS on all seven conversation rules + DB verification; three
  contract papercuts found and fixed (habit/idea disambiguation, effect
  direction, shaped empty search results). Prioritize/weekly/daily flows
  still to be dry-run.
- [ ] Dry-run every MCP flow with our own AI before calling it done: boot
  the backend on localhost, connect a **lightweight Sonnet subagent** as
  the MCP client (curl/HTTP bridge to the real Streamable HTTP endpoint —
  the prior branch's trajectory + two-agent-simulation pattern, revived
  small), and have it play the user side of a flow from
  CONVERSATION_FLOWS.md.
- [ ] A second lightweight Sonnet **review subagent** reads
  CONVERSATION_FLOWS.md + the dry-run transcript and judges: did the
  conversation follow the flow (digest-first, ≤2-3 questions, explicit
  go-ahead, "submitted for review" language)? Did data access actually
  work (reads returned real rows, change set landed with correct
  rows/FKs/classifications)? It may suggest prompt tweaks; apply and
  re-run — but keep the loop cheap and unceremonious, not a test suite.
- [ ] Minimum bar per flow: one happy-path dry run whose created records /
  read outputs are verified against the DB, plus flow-rule spot-checks by
  the reviewer. Not exhaustive simulation.
- [ ] API keys: NONE needed for this harness when driven from a Claude
  Code session (session subagents act as the MCP client and reviewer).
  ANTHROPIC_API_KEY is needed only for the server-side reconciliation
  agent — and later if we want these sims runnable headlessly in CI.

## Environment facts (this VM)
- [ ] Baseline verified 2026-07-20: backend `bunx tsc --noEmit` clean; `bun test` 155 pass / 0 fail (scratch DB_PATH); dashboard `bun run build` green. Dashboard `tsc --noEmit` fails on PRE-EXISTING env-TS-version issues (baseUrl deprecation, css side-effect import) — the dashboard gate is `bun run build`, not tsc.
- [ ] `thoughts/` at repo root is untracked trajectory-test output — never commit it. Never `git add -A`.
- [ ] Branch: codex/mcp-rework (cut from 6f1e46e, tip of codex/organized-mcp-workspaces). Old branch + PR #5 keep full history; original code readable there forever.
