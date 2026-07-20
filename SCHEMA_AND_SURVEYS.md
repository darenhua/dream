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

## Part 2 — Proposed schema

### Universal versioning columns (every content model)
```
id              version row id (uuid)
lineageId       stable logical identity (= first version's id)
version         int, 1..n
prevVersionId   nullable (null for v1)
createdAt
```
- Living-graph FKs reference **lineageId** (follow the head). Time-layer
  records (picks, weekly/daily plans) pin **version ids**.
- `lineage_parent` (polymorphic): `childType, childLineageId, parentType,
  parentVersionId` — remix/branch parentage; multi-row = combine.
- Conversation linkage (all models): `conversation_record_link`:
  `conversationId, sliceEndIdx, markerToken, recordType, recordVersionId,
  role: created_central | created_satellite | mentioned`.

### Information side
| Table | Key columns (beyond versioning) | Adapted from |
|---|---|---|
| `goal` | title, whyMd (what it means to me / identity), successMd? | `organized_goal` (drop priorityRank — priority is derived from the active pick; drop sources→raw) |
| `pattern_of_behavior` | title, triggerMd, emotionMd, copingMd, feedbackLoopMd | new |
| `goal_pattern` | goalLineageId, patternLineageId ("pointer on goal") | new |
| `habit` | title, note, valence(good/bad), origin(conversation\|system), status(active\|kept\|lapsed), activeExperimentId? (system habits: which pick birthed it) | `habit` (drop rrule/preferredTime → scheduling moves to scheduled_event; drop raw origin enum) |
| `goal_habit` | goalLineageId, habitLineageId, whyMd ("removing/changing this is part of the goal") | `goal_habit` + why |
| `environment` | title, note, origin(conversation\|calendar), habitLineageId (required when origin=conversation), effect(easier\|harder) | `environment_item` |
| `leisure_activity` | title, note, counteractsPatternLineageId?, fitsWhen? (free text: morning/evening/weekend) | new |
| `conversation` | (existing import columns, pipeline columns removed) | `conversation` |
| `takeaway` | markdownMd, date, activeExperimentId?, moodEnergy? **[OPEN shape]** | new (rant MCP output) |

### Ambition side
| Table | Key columns | Adapted from |
|---|---|---|
| `experiment_idea` | title, descriptionMd (can be one-liner), status(open\|retired) | new |
| `idea_goal` | ideaLineageId, goalLineageId, whyMd (why doing this serves that goal) | new — THE relationship whose why powers groups & planners |
| `project` | title, descriptionMd | `project` |
| `idea_project` | ideaLineageId, projectLineageId (many ideas per project) | new |
| `task` | title, detailMd, deadlineDate?, status(open\|done\|dropped), experimentIdeaLineageId? (≤1; presence = goal-minded task) | new (NOT the old `experimentTask`) |

### Grouping & time
| Table | Key columns | Adapted from |
|---|---|---|
| `experiment_group` | title, themeMd (the monthly theme / why these cohere), reasoningMd | `experiment_group` (lineage generalizes `parentExperimentGroupId`) |
| `group_idea` | groupLineageId, ideaLineageId, doneAt?, note? (membership + campaign done-state) | new |
| `group_habit` | groupLineageId, habitLineageId (bad habits being eliminated) | new |
| (group goal set) | derived through member ideas' `idea_goal` links **[OPEN: exact union vs curated at creation]** | replaces `experiment_group_goal` |
| `active_experiment` | groupVersionId (pinned), reasoningMd, startedAt, **endDate**, status(current\|ended\|expired), previousId | `current_focus` + endDate |
| `weekly_plan` | activeExperimentId, weekOf (Monday), themeMd, weeklyGoalMd, status(planned\|active\|ended), reviewMd | `experiment` kind=actionable, slimmed |
| `weekly_plan_item` | weeklyPlanId, kind(todo\|intention), text, doneAt? | new (structured, not a text blob) |
| `daily_plan` | weeklyPlanId, date, themeMd (work one-liner), notesMd, status | new |
| `scheduled_event` | entityType(habit\|task\|weekly_item\|daily_adhoc\|leisure), entityId, title, startAt, endAt, rrule?, gcalEventId?, **pushStatus(pending\|pushed\|failed)**, status(active\|cancelled) | `calendar_event` + explicit job status; GCal = source of truth |

### Review inbox
| Table | Key columns | Adapted from |
|---|---|---|
| `change_set` | summaryMd, operationsJson, conversationRef?, status(drafting→ready_for_review→applied\|rejected), rejectionNote/feedback, **reconciliationJson** (AI per-row classification: new / version-bump-of X / remix-of X / link-to-existing X), appliedAt | `draft_change_set` minus workspace/mode/invite |

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

## Part 4 — Open questions this pass surfaced

1. Are relationship rows (idea_goal, goal_habit) themselves versioned
   insert-only, or replace-on-review? (Spec says relationship data can be
   "updated" — proposal: same insert-only versioning, they're small.)
2. Group goal set: derived exact union vs curated at creation.
3. `strikes.ts` kind-filter must be verified before candidate deletion.
4. Witness/outbox system: keep dormant, adapt later, or delete.
5. Does `weekly_plan` keep the succeeded/failed judgment of old actionables,
   or is reviewMd (+ item done-states) the whole week-end story?
6. Takeaway shape (freeform markdown vs structured mood/energy fields).
