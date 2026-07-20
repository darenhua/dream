# Dream Rework — Conversation Flow Designs (v0)

Companion to REWORK_SPEC.md / SCHEMA_AND_SURVEYS.md / IMPLEMENTATION_PLAN.md.
Drafts of how each MCP conversation actually goes: opening message, agent's
first reply, and the path to the create. These become the skill prompts.

## Universal rules (every flow's system prompt)

0. Digest-everything is universal: record_create at the end of ANY thread
   (new, long, or MCP-less) digests the entire conversation into the
   proposed set. Reading is an EXPLICIT user act — the agent never pulls
   MCP data uninvited; the user asks for it.
1. The rant precedes the survey. When record_create is invoked at the end of
   a conversation, DIGEST — do not re-interview.
2. Search the DB before proposing: FK candidates come from the user's own
   records, surfaced conversationally ("I found your goal X — related?").
3. Capture whys near-verbatim in the user's words; they become the
   description on relationship rows.
4. At most 2-3 questions per turn, only decision-critical ones.
5. Stub-friendly: create thin; the version chain matures records.
6. An answered question is NOT a go-ahead. Explicit yes before every
   record_create call.
7. After creating: "submitted for review" — never "created/applied".
   Return includes the marker token for import stitching.
8. Linkage-depth invariants: goal-rant satellites create environments only
   via a habit, tasks/projects only via an experiment idea.

## A. Goal from a long self-rant (primary flow)

- Opening: user has already ranted at length; says "record create — turn
  this into a goal."
- Agent first reply: the full proposed set in one message — goal (title +
  description in the user's words), satellite sweep (bad habits with their
  goal-relationship whys, patterns as one-description records, experiment
  ideas each with why-it-serves-the-goal), PLUS only the undecidable
  questions (e.g. "is 'better lover' folded in or its own goal?",
  "attach the messy-room environment to the gym habit or leave it out?").
- Converge -> final set summary -> explicit yes -> ONE change set
  (central goal + satellites) -> review-inbox handoff line.

## B. Experiment idea

- Quick capture (blank thread): "record create: idea — I want to try
  tennis." Agent searches goals, proposes the link + asks for the one-line
  why. Two turns total.
- Mid-thread (Nth create in a conversation): no re-asking; agent proposes
  idea + goal links + whys already heard; confirm; create.

## C. Task

- Short rant then "record create task". Agent extracts title, deadline
  (from context: "before insurance resets" -> Sept 1), execution details,
  and EXPLICITLY confirms the absence of an experiment idea ("plain errand,
  right?"). Never manufactures goal-mindedness; proposes the idea link only
  when the conversation established it.

## D. Isolated pattern / project / leisure

- Pattern: rant about the behavior -> agent proposes ONE description
  capturing trigger/emotion/coping/loop in prose (structure lives in the
  prompt, not the schema) -> asks which goal it explains, or standalone.
- Project: proposal + search for related experiment ideas to link
  ("that's how it reaches your engineering goal").
- Leisure: the distinctive question is the pairing — "what feeling does
  this counteract, and when does it fit?" — because the daily planner
  queries exactly that.

## E. read_record — explicit, typed reads (+ the v2 branch flow)

Reading is always user-initiated ("pull down my goal X"); the agent never
reads uninvited. Two levels:

- **List-first**: "show me my goals / ideas / groups" → compact listing so
  the user can pick when they don't remember the exact record.
- **Typed pull-down** (mirrors create's per-model surveys):
  - goal → its habits (+relationship descriptions), patterns, ideas
    (+whys), groups serving it
  - experiment group → member ideas + done states + curated goal set
  - project → its linked ideas (and through them, goals)
  - task → its calendar items, deadline, linked idea if any
  - idea → its goal links + whys, group memberships, task/project
- **Zoom-in (second level, on request)**: the originating conversation
  slices — the actual rant text.

The v2 branch flow on top of it:
- Opening (blank thread): "pull down my 'house party' idea — new thinking."
- Agent (read_record): tight recap — current state, goal links + whys,
  group membership, done state. "What's the new thinking?"
- User rants the variant. Agent states its classification reading:
  update ("expanding the same thing -> v2") vs remix ("spin-off — new
  record derived from it, original stays intact"), lets the user veto,
  creates accordingly. Review inbox classification is the second check.

## F. Prioritize (monthly)

- Opening: "let's prioritize" (no current pick exists).
- Agent first reply: the landscape — every candidate group with goals
  served, idea counts, done-states from prior runs — then a gut question
  ("forget the groups: what's pulling at you for the next couple months?").
- Echo-back brainstorm loop (reflect, let the user rant, organize).
- Converges on: one group, an end date (translated into "N weekly plans —
  realistic?"), ranked goal set confirmed, reasoning in the user's words.
- Explicit go-ahead -> change set (pick with end_date).

## G. Weekly plan

- Opening: "plan my week."
- Agent first reply: state of play — week N of M, deadline distance, last
  week's item completions (done/not), big-ticket position — then capacity
  + readiness questions ("how scared is the party feeling now, 1-10?").
- Converge: theme one-liner + weekly goal + items (todos, intentions) ->
  negotiate the FEW anchored blocks (habit blocks, must-anchor tasks
  only) -> deadline-aware pushback if the user defers big-ticket work ->
  summary -> go-ahead -> change set -> dashboard review.

## H. Daily plan

- Opening: "plan tomorrow" (evening).
- Agent first reply: tomorrow's calendar reality + recent takeaway signals
  + deadline nags, then the fixed question set: energy? social urge? how
  heavy is work?
- Converge: theme one-liner (work-centric) -> full block proposal
  (invented blocks like matcha/walk/ask-boss included, weekly todos
  placed, leisure matched to the reported state) -> IN-CONVERSATION
  CONFIRMATION IS THE REVIEW -> events written (push to GCal) ->
  "it's on your calendar."

## I. Rant MCP — CUT

Removed from scope entirely (spec §8a). Venting happens in a
read_record-initialized conversation: the user pulls down the relevant
record (a goal, the current focus) and rants there with context loaded.
The takeaway record is cut with it; daily plans record the user's reported
state in their description, which successor plans read.
