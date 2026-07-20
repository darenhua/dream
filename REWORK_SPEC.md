# Dream MCP Rework — Consolidated Spec (v0)

Scope: everything established in the design conversation so far, and nothing
more. Items marked **[OPEN]** are undecided; items marked **[ASSUMPTION]** are
my inference awaiting confirmation. Dashboard views are described only where
the user has stated them; a full dashboard section is still to come.

## 1. Purpose and paradigm

The system exists to remind the user of who they are, who they want to be, and
how to get there sustainably — culminating in the ability to literally schedule
their days (including the rest they won't schedule for themselves).

- **No automated extraction.** The distill/derive/proposals pipeline is deleted.
  Records are created intentionally, through conversation, via MCP. The
  organized dashboard is the only dashboard; "organized goals" are now just
  **goals** (no link to any legacy raw layer — that layer is removed).
- Records come from **rants**: long therapy-style threads about the user and
  their goals, or small focused threads about one project/task/habit/idea.
- Records must be **self-sufficient for planning**: the whys and descriptions
  captured at creation are the planning context. Planners never read threads.

## 2. Universal write mechanics

- **Insert-only.** There are no updates anywhere. Every write is a create.
- Every create passes through the **dashboard review step** (human in the
  loop). An AI pass scans the DB and classifies every row that wants to be
  inserted:
  1. **New** — fresh record, new lineage.
  2. **Version bump** — really an update to an existing record → becomes
     v(n+1) in the same lineage, linked to its predecessor.
  3. **Remix/branch** — a derived-but-new idea (spin-off, recombination) →
     new lineage with parent link(s) to the source version(s). Combining
     multiple ideas is a multi-parent branch.
  The same classification applies to FK-side records the creating agent
  invented: the reviewer proposes "link to existing X" over duplicates.
- **Representation:** immutable version rows carrying `id` (version id),
  `lineageId` (stable logical identity), `version`, `prevVersionId`, plus
  branch-parent links. Living-graph FKs reference `lineageId` (follow the
  head); time-layer records (weekly/daily plans, picks) pin version ids.
  **[ASSUMPTION — recommended, not yet confirmed]**
- Early versions may legitimately be **stubs** (allusion-grade). The version
  chain is the specification process. Common flow: a goal rant alludes to a
  thing → stub v1; a later focused thread (initialized via read_record,
  "expanding on a previous thing") fully specifies it → v2.

## 3. Conversation linkage

- Conversations enter the DB via the Claude export zip (existing import path).
- One record_create call ↔ one conversation slice: everything before the call
  message. One call may create multiple records (one central + satellites),
  all sharing that slice.
- Stitching should be deterministic: record_create returns a **marker token**
  that appears in the exported transcript; import matches slices by token.
  **[ASSUMPTION — recommended]**
- Records exist before their thread text is imported; links are backfilled at
  import time.
- Only **read_record** ever loads thread content into a conversation.

## 4. Data models

### Information side (what already exists / is true of me)

| Model | Notes |
|---|---|
| **goal** | The hub. Carries identity/why-it-matters description. Holds the pointer(s) to related patterns of behavior. |
| **pattern_of_behavior** | Trigger → emotion → coping mechanism → feedback loop (e.g. shame spiral). Tied to goals via a pointer on the goal, or dangling. Read by the rant MCP, NOT by planners. |
| **habit** | Two origins: (a) conversation-derived — almost always **bad** habits, born as stubs in goal rants; the goal↔habit link means "removing this is part of the goal"; (b) system-created — habits being actively established, born from a picked experiment (see §6), manifesting as scheduled calendar events. Stays listed while a current/past experiment established it and the user keeps it going. |
| **environment** | Purpose: makes a habit easier or harder. Two origins: (a) conversation-derived, only ever created attached to a habit (chain: goal ← habit ← environment); (b) calendar-derived standing events — never from conversation. |
| **leisure_activity** | Things the user likes (park with a friend, morning matcha, runs, incense). Each may link to the pattern/default-response it counteracts. Read by weekly and daily planners to schedule intentional rest. |
| **conversation** | First-class model: imported threads, slices, record links. |
| **takeaway** | Output of the rant MCP (optional): a status/state document ("how the experiment is going", "I'm exhausted"). Read by planners as recent state. **[OPEN: exact shape]** |

### Ambition side (what doesn't exist yet)

| Model | Notes |
|---|---|
| **experiment_idea** | The general, volatile ambition record — can be a one-liner. Links to goals with the **why on the relationship** (why doing this serves that goal). Can dangle. Quick capture from a blank thread with no initialization is valid. |
| **project** | Long-running thing to build. Reaches goals only via experiment ideas (a project may have many ideas). Can dangle. |
| **task** | One-off responsibility ("go to the doctor"). Usually a single record, no FKs, with optional deadline. A task with an associated experiment idea (≤1 per task) is thereby goal-minded; the idea is the bridge. Can dangle. |

### Grouping and time

| Model | Notes |
|---|---|
| **experiment_group** | A cohesive set of experiment ideas + reasoning why they harmoniously achieve a set of goals + the bad habits being eliminated. Goal set is **derived through member ideas' goal links** [OPEN: exact union vs curated at creation]. Created by branching/combining ideas (multi-parent), or directly. The monthly **theme**. |
| **group↔idea membership** | Separate from the idea's goal links (which are permanent meaning). Ideas can belong to multiple groups. Carries **done/crossed-off state** for that campaign. **[ASSUMPTION: done lives on membership]** |
| **active_experiment** (pick) | The record marking the currently picked group. Carries reasoning/context/description (it IS the monthly plan) and an **endDate**. Expiry re-arms prioritize. Holds the FK to habit records materialized from the group's habit-establishing ideas. |
| **weekly_plan** | FK to active pick. Week window; weekly goal statement + **theme** ("rejection therapy week"); created-habit FKs; anchored schedule blocks; structured to-do items (child rows with done state) consumed by daily planning; noted intentions (things to do this week that are NOT scheduled, e.g. "tell a girl she's beautiful"). Expires after exactly one week; next plan ideally authored ~2 days before expiry (overlap window supported). Successors read predecessors. |
| **daily_plan** | Plan for one day. **Theme** as a one-liner, closely tied to work. Reads current weekly plan (not past ones), recent past daily plans, incomplete tasks, leisure activities, recent takeaways, and the calendar. Schedules heavily, including invented events (make-breakfast block, 1pm walk, 3pm ask-boss note). |
| **schedule/bookkeeping table** | First-party record of scheduled events with sync status. **Google Calendar is the source of truth** for events; these rows are bookkeeping ("was the calendar-creation job done"). Day/time-of-week schema. Habit records link to their events here. |

### Linkage-depth invariants for goal-rant satellites

A record_create on a me-and-my-goals rant creates satellites liberally for
goals, experiment ideas, habits, patterns — but creates an environment only
attached to a habit (two hops: goal ← habit ← environment), and a task or
project only attached to an experiment idea. If the full chain isn't clear
from the conversation, the record is not created. (No hesitancy heuristic;
these structural rules replace it.)

## 5. The MCP surface (six commands)

1. **record_create** — the only way records are born. Multiple calls per
   thread; each targets what the conversation most recently discussed. Fills a
   per-model **survey** from conversation context; one call may produce a
   central record plus FK satellites in a single reviewed change set (the
   all-in-one shape; single-record calls are the degenerate case).
2. **read_record** — initializes a blank conversation with a record's context
   by reading the record and its originating thread slices, and following FK
   links across conversations. The front door for branching, enrichment, and
   never-re-explaining-yourself. All branches start from an initialized
   conversation; not every initialized conversation branches.
3. **prioritize** — runs when no active pick exists. Reads all candidate
   groups → their goals → attached context; conversational brainstorm (echo
   back, let the user rant, organize); ends with one picked group + endDate.
   On expiry without success: branch the group (v2 or remix) picking up where
   it left off, pickable again. (Today's current_focus machinery approximates
   this; the endDate is new.)
4. **weekly_plan** — blank thread. Pulls active group → its ideas → ALL past
   weekly plans for this group → schedule context. Suggests the weekly goal
   from all the whys; converges conversationally; schedules only habit blocks
   and must-anchor tasks (negotiated back and forth); records intentions and
   to-do items unscheduled. Deadline-aware: knows weeks remaining and pushes
   back honestly. Ends in dashboard review. Builds momentum week over week
   (stack wins: tell friends → house music → throw the party), reading
   predecessor plans and membership done-states.
5. **daily_plan** — plans tomorrow. Context: current weekly plan + windowed
   recent daily plans + incomplete tasks (deadline-filtered) + leisure
   activities + recent takeaways + Google Calendar. Asks about energy, social
   desire, work busyness (prompt set fixed in v1, editable later). Schedules a
   lot, including ad-hoc and invented events; drains the weekly to-do list;
   nags daily on unanchored deadline tasks until scheduled. Work-life context
   supplied via a standing editable record. **[OPEN: review weight — proposed
   that in-conversation confirmation IS the review for daily plans.]**
6. **rant** — pure expression and context. Loads patterns of behavior and bad
   habits so the user never re-explains themselves; creates NO records by
   default; optional record_create at the end (most often a takeaway).

### Planner read-scope matrix

| Context | prioritize | weekly | daily | rant |
|---|---|---|---|---|
| Whys/motivations (goals, ideas, groups) | yes | yes | yes | yes |
| Rant threads | never | never | never | (is one) |
| Past weekly plans (this group) | — | yes | no (current only) | — |
| Past daily plans | — | — | windowed (~7) | — |
| Patterns of behavior / bad habits | no | **no** | **no** | **yes** |
| Leisure activities | — | yes | yes | — |
| Incomplete tasks + deadlines | — | yes | yes | — |
| Takeaways (recent) | — | [ASSUMPTION: yes] | yes | — |
| Google Calendar | — | yes | yes | — |

## 6. Habit materialization pipeline

idea ("no phones before bed", plaintext, not on habit table) → grouped →
group **picked** (pick record → habit record FK) → weekly actionable begins →
**only then** are calendar events created (hard rule; habit-row creation may
happen at pick time as an acceptable compromise) → syncs to GCal → lives on
the active-habit list while kept going.

## 7. v1 scoping decisions

- Planners read records only; structured whys are load-bearing.
- Context windowing: daily reads current weekly + last ~7 dailies + calendar.
- Fixed planner question set first; prompt editability later.
- No calendar writes outside a confirmed conversation; no background writes.
- Work context = one standing editable record.
- Marker-token conversation stitching at import.
- All-in-one record_create (central + satellites) in one reviewed change set.

## 8. Deleted from today's code

Rant detection, distill/extraction review, derive/proposals/enrichment, the
proposal ledger, the raw-vs-organized split (organized becomes the only layer,
renamed), and the associated dashboard screens (RantExplorer,
RantCandidatesGate, ExtractionReview, ProposalReview, ProposalLedger).
Retained in spirit: group lineage/branching, pick/sunset one-active-group
machinery, atomic draft → dashboard review membrane, calendar sync (inverted:
GCal as source of truth), conversation import.

## 9. Still to come from the user

- Dashboard views (stated so far: centers active prioritized goal, active
  weekly experiment, daily plan, experiment groups; must surface relevant
  patterns/philosophies and what goals mean to the user and why chosen).
- Exact per-model survey contents.
- Takeaway record shape; group goal-set derivation rule; daily review weight.
- ~~MCP auth/surface packaging~~ **DECIDED: single persistent surface, no
  code ceremony and no MCP auth. The invite/OTP machinery is deleted.**
