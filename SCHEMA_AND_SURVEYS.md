# Dream Rework — Adapted Data Model & record_create Surveys (v0)

Companion to REWORK_SPEC.md. Built from a code-mapping pass over the existing
backend (four subsystem research reports: conversation import, calendar/
scheduling, collaboration/review machinery, experiment lifecycle + dashboard).
Principle: adapt the organized-goal system — the closest existing parallel —
and delete the derived/proposals ledger. **[OPEN]** marks undecided points.

---

## Part 1 — What the codebase gives us (mapping summary)

### Reusable nearly as-is
- **Conversation import engine** (`ingestion.ts`, `parser.ts`): active-path
  reconstruction from the Claude export tree (drops abandoned edit branches),
  content-hash dedup, safe re-import that updates content in place. The slug
  detector (`parser.ts:113`) is already a marker-locator returning a message
  index — exactly the slice-stitching mechanism, generalized to our marker
  tokens. `extraction.startIdx/endIdx` is the span prior art.
- **Review membrane** (`collaboration.ts:625-793`): the draft change-set
  status machine (drafting → ready_for_review → applied/rejected), guarded
  transactional apply with optimistic concurrency, and the
  return-to-drafting-with-feedback loop. This generalizes directly into the
  new review inbox.
- **Live organized read models** (`companion.ts:419-649`): overview, LIKE
  search over titles/synthesis, single-record detail with discovered sources,
  relation walking, provenance drilling. Maps ~1:1 onto `read_record`.
- **Free-time/calendar core**: `freeTime.ts` (pure window math), `busyByDate`
  (freebusy across ALL calendars), anchor-tap day overrides, Google client +
  OAuth, syncToken incremental sync. Planners' plan-around-commitments
  primitive already exists.
- **Actionable FSM verbs** (`experiments.ts`): `confirmActionableSchedule`
  (activate pre-created rows, push calendar), `endExperiment` (+ review
  writeup pipeline), weekOf-Monday semantics, one-live-per-week guards.
- **Dashboard skeleton** (`OrganizedFeed.tsx`): the focus → groups →
  actionables card hierarchy, the CompanionInboxCard review-inbox pattern,
  DetailModal / draft-review dialogs.

### Needs rework
- `parser.ts` `assembleContent` ignores the export's typed `content[]` blocks
  — MCP tool-call markers would vanish. Must read them; retain message uuids
  for robust stitching.
- Calendar policy: times are already GCal-authoritative; existence/metadata
  are not. Extend to full "GCal is source of truth"; add an explicit
  `pushStatus` job column (today `gcalEventId=null` is the only signal);
  add bulk/idempotent ad-hoc event creation + throttling (daily plans write
  many rows); consolidate the two near-duplicate calendar-row writers.
- Operations render as raw JSON in review dialogs — the three-way
  classification (new / version / remix) needs a real diff/compare renderer.
- `reviewMd` carry-forward week to week is ad-hoc; becomes explicit context
  for weekly_plan.

### Deleted outright
Proposals apply-switch + enrichment (`proposals.ts`, `revise.ts`,
`derive.ts`, `distill.ts`, `rantDetection.ts`), extraction tables +
links, candidate experiments (`enqueueExperiment`, `GET /candidates`,
checklist UI), legacy schedule-chat path (`pickExperiment`/`commitPlan`),
conversation pipeline columns (slug/rant/distill/derive stamps + FSM),
ALL auth ceremony (`collaborationInvite`, OTP redemption, dashboard
capability hashes, companion identity/bearer/loopback + peer-header
machinery, redemption rate limiting, the mode system), workspace snapshot
index table (context is assembled live instead), raw-layer tables
(goal/habit/environment_item/experience/project raw registries),
`experience` as a model. Watch-edges when deleting: `openLoopSection`
reads workspace+companion tables (re-generalize over the new change_set);
companion queries filter on identity (drop predicates, not leave dangling);
`strikes.ts` may not filter `kind` (verify before candidate deletion).
Witness/outbox system: untouched by this phase **[OPEN: long-term fate]**.

---

## Part 2 — Proposed schema (v1, old → new)

### Infrastructure (new, shared by every content model)
```
versioning columns on every content table:
  id                version row id (uuid, PK)
  lineage_id        stable logical identity (= first version's id)
  version           int, 1..n
  prev_version_id   nullable
  created_at

lineage_parent      -- remix/combine parentage (multi-row = combine)
  id, child_type, child_lineage_id, parent_type, parent_version_id, created_at

conversation_record_link   -- provenance spine (replaces extraction_link)
  id, conversation_id, marker_token, slice_end_idx?,
  record_type, record_version_id,
  role: created_central | created_satellite | mentioned, created_at
```
Relationship tables reference **lineage ids** → version bumps propagate to
every relationship automatically (decision #1: never agent work). Time-layer
records (picks) pin **version ids**.

### Old → new, model by model

**goal** ← `organized_goal`
```
OLD: id, title, identity_clause, synthesis_md, priority_rank,
     status(active|sunset|archived), timestamps
NEW: [versioning] title, why_md (identity_clause+synthesis merged: what this
     means to me), success_md?, status(active|sunset|archived)
     -- priority_rank DROPPED: priority derives from the active pick's group
```

**pattern_of_behavior** (new) + **goal_pattern** (new)
```
pattern_of_behavior: [versioning] title, trigger_md, emotion_md, coping_md,
                     feedback_loop_md, note_md?
goal_pattern:        id, goal_lineage_id, pattern_lineage_id, created_at
```

**habit** ← `habit` (raw) merged with `organized_habit`
```
OLD raw:  id, title, note, valence, status(established|building|lapsed),
          rrule, preferred_time, duration_minutes, experiment_id, origin
OLD org:  id, title, note, synthesis_md, status(active|sunset|archived)
NEW: [versioning] title, note_md, valence(good|bad),
     origin(conversation|system), status(active|lapsed),
     active_experiment_id?   -- system habits: which pick birthed it
     -- rrule/preferred_time/duration DROPPED: timing lives on scheduled_event
goal_habit: id, goal_lineage_id, habit_lineage_id, why_md, created_at
```

**environment** ← `environment_item` merged with `organized_environment_item`
```
OLD: id, title, note, sub_kind(physical_setup|obligation|social),
     status(active|removed), rrule, duration_minutes, origin
NEW: [versioning] title, note_md, origin(conversation|calendar),
     habit_lineage_id?  -- REQUIRED when origin=conversation,
     effect(easier|harder)?  -- meaningful for conversation origin
     -- calendar-origin rows represent standing recurring events
```

**experiment_idea** (new) + **idea_goal** (new)
```
experiment_idea: [versioning] title, description_md (one-liner ok),
                 status(open|retired)
idea_goal:       id, idea_lineage_id, goal_lineage_id, why_md, created_at
                 -- THE why-bearing relationship groups and planners read
```

**project** ← `project` / **task** (new) / **idea_project** (new)
```
project:      [versioning] title, description_md
idea_project: id, idea_lineage_id, project_lineage_id, created_at
task:         [versioning] title, detail_md?, deadline_date?,
              status(open|done|dropped),
              experiment_idea_lineage_id?  -- ≤1; presence = goal-minded
```

**experiment_group** ← `experiment_group`
```
OLD: id, title, motivation_md, parent_experiment_group_id,
     status(candidate|active|done|sunset|archived), closing_review_md,
     archived_at, archived_from_status
NEW: [versioning] title, theme_md, reasoning_md, status(candidate|archived)
     -- parent link generalized into lineage_parent
     -- active/done/sunset DROPPED: "active" derives from the current pick;
        an unfinished expired group branches to v2 instead of closing
group_idea:  id, group_lineage_id, idea_lineage_id, done_at?, note?
group_habit: id, group_lineage_id, habit_lineage_id, created_at
group_goal:  id, group_lineage_id, goal_lineage_id, rank, created_at
             -- seeded as union of member ideas' idea_goal links,
                curated+verified in the group conversation (decision #2)
```

**active_experiment** ← `current_focus`
```
OLD: id, experiment_group_id, previous_current_focus_id,
     status(current|ended|superseded), entry_reason(pick|sunset),
     reasoning_md, source_change_set_id, started_at, ended_at
NEW: id, group_version_id (PINNED), reasoning_md, started_at,
     end_date, ended_at?, previous_id?, change_set_id, created_at
     -- "current" = ended_at null; entry_reason and the sunset ceremony die
     -- current_focus_goal table DROPPED (goal set = group_goal, ranked)
```

**weekly_plan** ← `experiment` (kind=actionable, radically slimmed)
```
OLD: id, title, hypothesis_md, kind, experiment_group_id, week_of,
     status(queued|scheduling|running|succeeded|failed|archived),
     proposal_id, bandwidth, planned_duration_days, proposed_changes_json,
     plan_json, queued_at, started_at, ended_at, outcome_md, review_md
NEW: id, active_experiment_id, week_of (Monday), theme_md,
     weekly_goal_md, created_at
     -- NO status, NO review_md (decision #5): the next plan reads this one
        plus completion data; nothing succeeds or fails
weekly_plan_item: id, weekly_plan_id, kind(todo|intention), text, done_at?
```

**daily_plan** (new)
```
daily_plan:      id, weekly_plan_id, date, theme_md (work one-liner),
                 notes_md?, created_at   -- no status
daily_plan_item: id, daily_plan_id, kind(block|todo|leisure), text,
                 scheduled_event_id?, task_lineage_id?, done_at?
                 -- done_at is the manual dashboard CRUD; doubles as the
                    habit-tracking signal (decision #5)
```

**leisure_activity** (new) / **takeaway** (new)
```
leisure_activity: [versioning] title, note_md,
                  counteracts_pattern_lineage_id?, fits_when?
takeaway:         id, markdown_md, date, active_experiment_id?, created_at
                  (append-only, not versioned) [shape still open]
```

**scheduled_event** ← `calendar_event`
```
OLD: id, entity_type, entity_id, gcal_event_id, title, start_at, end_at,
     rrule, block_style, status(active|cancelled|needs_reschedule),
     last_synced_at
NEW: id, entity_type(habit|task|weekly_item|daily_adhoc|leisure), entity_id,
     title, start_at, end_at, rrule?, block_style, gcal_event_id?,
     push_status(pending|pushed|failed), status(active|cancelled),
     completed_at?, last_synced_at, timestamps
     -- needs_reschedule dropped; GCal is source of truth for event state
```

**change_set** ← `draft_change_set`
```
OLD: id, workspace_id, mode, primary_entity_type/id, summary_md,
     operations_json, source_refs_json, audit_json,
     status(drafting|ready_for_review|applied|rejected|expired),
     rejection_note, applied_at, rejected_at
NEW: id, summary_md, operations_json, audit_json?,
     reconciliation_json  -- AI per-row classification: new | version-bump-of
                             X | remix-of X | link-to-existing X,
     marker_token, status(drafting|ready_for_review|applied|rejected),
     rejection_note (feedback), applied_at, rejected_at, timestamps
     -- workspace/mode/invite/primary-entity machinery all dropped
```

**conversation** ← `conversation` (kept, pipeline columns stripped)
```
KEEP: id, source, external_id, title, content_json, raw_json, content_hash,
      source_created_at, source_updated_at, parse_error, timestamps
DROP: slug_detected, slug_message_idx, rant_verdict, rant_status,
      rant_detected_at, rant_resolved_at, detector_note, distill_requested,
      distilled_at, extractions_reviewed_at, derived_at
```

### Tables deleted outright
`extraction`, `extraction_link`, `proposal`, raw `goal`, `goal_evidence`,
`experience`, `experiment_task`, `experiment_task_goal`, `experiment_goal`,
`experiment_organized_goal`, `current_focus_goal`, `organized_goal_source`,
`organized_registry_source`, `project_source`, `experiment_group_goal` (→ new
`group_goal`), `experiment_group_target`, `experiment_group_context`,
`experiment_group_project`, `experiment_group_source`,
`collaboration_invite`, `collaboration_workspace`,
`collaboration_workspace_index`, `companion_branch_draft`, `chat_session`,
`chat_message`, `daily_writeup`, `review_writeup`.
Left dangling untouched (explicitly ignored): `witness`, `witness_goal`,
`outbound_message`, `inbound_message`, `strike_state`.

---

## Part 3 — The surveys

A survey = the checklist record_create must satisfy before drafting the
change set. Universal mechanics for every survey:

1. **Answer from the conversation first.** Only ask what is missing AND
   decision-critical. Never run an intake questionnaire.
2. **Propose FK candidates from the DB.** Search existing records (the
   companion search models) and surface matches conversationally: "I noticed
   you have the goal X — is this related?" The user's confirmation +
   explanation becomes the relationship's whyMd.
3. **Evidence rule.** Every filled field and proposed satellite must point at
   something actually said; nothing invented. Uncertainty goes in an audit
   note for the reviewer.
4. **Output = one change set** (central record + satellites, FKs pre-wired)
   → review inbox, where the AI reconciliation pass classifies every row.
5. **Stub-friendly.** Missing non-critical answers → create the stub anyway;
   the version chain is the specification process.

### goal (central; liberal satellite sweep)
- Title — short name for the goal.
- whyMd — what this means to me, in my words; the identity behind it.
- successMd — what change would look like. *(optional, stub-friendly)*
- **Satellite sweep of the rant:**
  - every bad habit mentioned → habit(valence=bad) + goal_habit.whyMd (how
    it blocks the goal / why removing it is the goal)
  - every improvement idea mentioned → experiment_idea + idea_goal.whyMd
  - every pattern mentioned → pattern_of_behavior (trigger, emotion, coping,
    feedback loop) + goal_pattern
  - environment factors ONLY when attached to a specific habit →
    environment(effect) chained goal ← habit ← environment
  - projects/tasks ONLY when attached to an experiment idea

### experiment_idea
- What is the idea (title + description; one-liner is fine).
- Which goals does it serve? — DB search proposes candidates; for each
  confirmed: whyMd on idea_goal, in the user's words.
- Any readiness/fear context worth keeping? (goes in descriptionMd/audit)
- Does it concretize into a task or project mentioned here? (attach)

### habit (conversation origin = bad habit)
- What is the habit; valence (almost always bad from conversation).
- Which goal is it part of removing/changing? + whyMd on goal_habit.
- Any environment factor that makes it easier/harder? (→ environment)
- Any pattern of behavior it feeds? (→ via goal_pattern context)

### pattern_of_behavior
- Name it. Trigger — what sets it off. Emotion — what it feels like.
  Coping mechanism — what I do. Feedback loop — how it sustains itself.
- Which goal(s) does it explain/affect? (→ goal_pattern)

### environment
- The factor (friend, messy room, standing commitment).
- Which habit does it affect, and does it make it easier or harder?
  (required — no dangling conversation-origin environments)

### task
- What has to be done; any detail needed to execute it.
- Deadline? (drives planner nagging)
- Is there an experiment idea behind it? Only if the conversation
  established it (presence = goal-minded task; absence = plain errand).

### project
- What are we building; scope (long-running).
- Which experiment ideas relate? (attach; goals are reached via those ideas)

### leisure_activity
- The activity; what it needs (time of day, people, place).
- Which pattern/feeling does it counteract? ("run when overwhelmed",
  "park with a friend when lonely") — powers weekly/daily leisure planning.

### experiment_group
- Seed: which idea or goal starts this.
- Pull related ideas + goals from DB (search; clarifying questions allowed
  first); confirm the membership set.
- themeMd — the coherent theme ("becoming more outgoing and self-expressive").
- reasoningMd — why these ideas harmonize to achieve these goals (reads the
  idea_goal whys).
- Bad habits being eliminated (→ group_habit).
- Confirm the derived goal set **[OPEN: curated vs exact union]**.

### takeaway (rant MCP, optional exit)
- What is this about (experiment status / general state)?
- How am I feeling; energy level.
- Which active experiment / weekly plan does it speak to, if any?

---

## Part 4 — Decisions (resolved with the user)

1. **Relationship propagation is automated, never agent-authored.**
   Relationship rows reference **lineage ids**, so a version bump propagates
   to every relationship structurally — no rows to rewrite. (If version-
   pinned relationship history is ever wanted, auto-copy rows at apply time;
   not agent work either way.)
2. **Group goal set: seeded as the union** of member ideas' goal links, then
   **curated and verified in conversation** at group creation → stored as an
   explicit `group_goal` set (with priority rank, used when picked).
3. **Strikes system: ignore entirely, leave dangling** in current code.
4. **Witness/outbox system: ignore entirely, leave dangling.** Core flow only.
5. **Plans have NO statuses and no reviewMd/failure states.** A plan is
   never succeeded/failed — the next plan simply reads its predecessor and
   the completion data. Completion is tracked by manual CRUD in the
   dashboard: done-flags on daily-plan items (which doubles as the habit
   signal) and on weekly items / group ideas. The next-day/next-week MCP
   reads that completion data and may ask recap questions.
6. Takeaway shape: still open (freeform markdown + optional links for v1).
