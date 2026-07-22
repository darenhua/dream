# Dream: the product model

*Written 2026-07-22, immediately after the merge of PR #6 (the MCP rework).
This is the durable statement of what Dream is trying to accomplish. Status
conventions used throughout the docs/ tree:*

- *(no tag)* — implemented and verified in the current codebase.
- **[TARGET]** — agreed direction from the post-merge review, not built yet.
- **[UNCERTAIN]** — an interpretation the author was not sure about; confirm
  with Daren before building on it.
- **[DECISION OPEN]** — deliberately unresolved; needs a call before work.

---

## 1. What Dream is

Dream is a **single-user life-organization system** for Daren. Its job is to
turn unstructured self-reflection (long spoken "rants" in Claude
conversations) into a durable, reviewable web of records — goals, habits,
patterns of behavior, experiment ideas, projects, tasks, leisure activities —
and then to drive **three levels of planning** off that web, ending in real
blocks on a real Google Calendar.

Three design commitments define the system (all implemented):

1. **Intentional conversational capture, not ambient extraction.** The old
   pipeline (rant detection → distillation → derivation → proposals) was
   deliberately deleted in the rework. Records are created only when the user
   *asks* the agent to digest a conversation into records
   (`record_create` on the Dream MCP). The agent digests; it does not
   interview.
2. **Insert-only versioned records.** Nothing is ever updated in place. Every
   content record carries `lineage_id` / `version` / `prev_version_id`; an
   "edit" is a new version on the same lineage, a spin-off is a **remix**
   (new lineage with `lineage_parent` rows — multiple parents allowed).
   Relationships point at *lineage ids*, so version bumps propagate for free.
   There are **no status enums**: state derives from timestamps
   (`retired_at`, `done_at`, `ended_at`, …) plus "latest version of lineage".
3. **A human-in-the-loop review membrane.** Every record-creating
   conversation produces a *change set* that lands in a dashboard review
   inbox. An AI reconciliation pass suggests verdicts (new / version bump /
   remix / link to existing); the human applies, revises, or rejects. The one
   exception: daily plans write directly, because the conversation itself is
   the review (see §3).

Provenance is first-class: every applied record keeps a
`source_conversation_id`, and marker tokens (`rc_<12hex>`) emitted by
`record_create` stitch imported chat exports to the records they created
(`backend/src/services/provenance.ts`).

## 2. The record ontology, in one page

| Record | Meaning | Key nuance |
|---|---|---|
| goal (`organized_goal`) | An identity-level want, in the user's words | The description is planning fuel; links carry "whys" near-verbatim |
| pattern_of_behavior | Trigger → emotion → coping → feedback loop | ONE prose description; explains goals |
| habit | A behavior that **already exists** (almost always bad) | A proposed *new* recurring behavior is an experiment_idea, never a habit — it only becomes a habit when a weekly plan establishes it (system-origin) |
| environment_item | A factor making a specific habit easier/harder | Only ever attached to a habit |
| experiment_idea | Ambition — a thing to try, by definition not yet done | The information/ambition split: ideas are ambition, goals/patterns are information |
| project | Long-running thing to build | Reaches goals only through ideas |
| task | One-off responsibility, optional deadline | Goal-minded only if an idea backs it; otherwise a plain errand |
| experiment_group | A curated set of ideas + habits aimed at ranked goals | The unit of monthly commitment |
| leisure_activity | Intentional rest fuel | Description MUST carry the feeling-pairing ("for when I'm overwhelmed: …") |

Legacy table names were **kept on purpose** (`organized_goal`, `experiment` =
weekly plan, `experiment_task`, `current_focus` = monthly pick, …) to avoid a
risky rename migration against live prod data. See
`SCHEMA_AND_SURVEYS.md` for the full schema contract.

## 3. Three-level planning philosophy

All three planners read the goal web's "whys" — the user's own words on why
each link exists — so plans stay tied to identity, not just productivity.

- **Monthly = conviction.** `prioritize_context` + a `pick` op: commit to ONE
  experiment group with an explicit end date and reasoning. Expiry has no
  status flag — a pick is current while `ended_at` is null and its end date
  is ahead. An expired pick invites a *branch* of the group (v2), not silent
  drift.
- **Weekly = momentum.** One `create_weekly_plan` op: `weekOf` (a Monday),
  **theme**, description (weekly goal + reported state), items
  (todo/intention), `habitStarts` (this is where a new habit is actually
  *materialized*: a system-origin habit record plus a recurring calendar
  block), anchored events, and ideas marked done. Momentum rules live in the
  tool description: stack wins, start tiny, push back with the deadline when
  the user defers.
- **Daily = specifics.** `daily_plan_context` + `create_daily_plan` (direct
  write — the conversation is the review). Blocks, todos, and leisure; the
  plan's description stores the *reported state* (energy/social/work), which
  tomorrow's planner reads back. Unanchored deadline tasks are the **daily
  nag** — asked about every day until scheduled. Completion is manual
  dashboard toggles; a completed scheduled block also stamps its calendar
  event (the habit signal).

**[TARGET]** The daily conversation must also ask about **leisure and
bandwidth** (observed gap: it currently doesn't ask at all) and should be able
to collect initial leisure-activity stubs in the flow.

## 4. Themes versus tasks

The `theme` field exists today on weekly plans (`experiment.theme`) and daily
plans (`daily_plan.theme`, required). What goes *in* it is the product point,
and current agent guidance under-specifies it. **[TARGET]** — the standard,
in Daren's words:

A theme is **the one-liner kept in the back of the mind that contextualizes
every micro-decision of the day/week** — how you make your coffee, how you
talk to your boss, your posture — and it always has a **why tied to goals and
patterns of behavior**. Themes are deliberately vague, general, and
mindset-focused. A vision for the mindset ("why does internalizing this help
me be who I want to be?") is part of the theme.

The litmus test: **if it only affects one decision, it's a task, not a
theme.**

- Weekly example: *"Living like Andre 3000"* — affects how he dresses, how he
  talks, all week; contextualized by his goals for wanting that.
- Daily examples that pass: *"be sunny and chalant"*, *"drippy and swaggy"*,
  *"work hard today"*, *"process your emotions with AI"*, *"go on a walk when
  things get hard"*.
- Fails the test: *"dress nicely like Andre 3000"* — it only affects the
  morning decision. That is a good daily-plan **task**, not the theme.
- Upgrade pattern: *"mind your posture today"* is decent; *"be classy and
  attractive"* (with posture in the description) is better — the vague
  mindset in the theme, the concrete handle in the description.

## 5. Accountability model **[TARGET — dormant infrastructure exists]**

Nothing here is wired up today, but `witness`, `outbox`/`outbound_message`,
and `strike_state` tables plus `backend/src/services/{witnesses,outbox,strikes}.ts`
survive from the old system, and `docs/messenger-local-switch.md` records the
unfinished messaging-transport work (Photon cloud probe failed; local
iMessage Kit was the planned replacement). Three purposes, in priority order:

1. **Don't quit the system.** Missing more than 2 daily plans triggers
   messages to friends, on an **exponential backoff** schedule
   **[UNCERTAIN: exact backoff semantics — e.g., whether backoff resets on a
   completed plan — need a call]**.
2. **Recaps on weekly-plan creation — the primary deliverable.** When a new
   weekly plan is created, friends get a simple recap: *"Daren finished doing
   X — ask him how it went; he's going to start doing Y."* Ideally it
   includes **one interesting conversation starter** about the goal/idea, so
   Daren can share more manually.
3. **Support before big scary tasks**, and more broadly a relationship of
   people who know each other's goals, progress, and ideas — visibility
   toward large risky attempts so nobody quits quietly.

## 6. One-page contextual planning documents **[TARGET]**

A growing list of simple one-pager spec/markdown documents associated with a
specific day, week, or month plan. Purpose: the *plan records stay immutable*
(don't grow or mutate experiments once made), but **context changes** — the
one-pager is where evolving context lives. Example: the weekly plan says
"practice guitar 45 min"; tomorrow's daily one-pager says "practice triads
first, then this chord in this way." They must be readable (to remind
yourself) and chattable (to plan or do the task in conversation).

**[DECISION OPEN]** Storage: new record model vs. plain files vs. config
rows. They also feed the **"doing current task" flow** [TARGET]: pull the
current event from the Google Calendar MCP → resolve the Dream task → read
its description → pull the relevant daily/weekly plan parts and one-pagers →
so the user can open with "ugh, I really don't want to do this task" and a
generic assistant can talk them through it.

## 7. Google Calendar and Dream calendar responsibilities

The division of labor (implemented; server instruction rule 11 in
`backend/src/mcp/dreamServer.ts`):

- **Google Calendar is the source of truth for availability.** Before
  proposing ANY schedule times, the agent reads the user's **live** calendar
  through their external Google Calendar MCP — the whole day ahead for a
  daily plan, the whole week ahead for a weekly plan — and proposes blocks
  only into real gaps. The user rearranges events constantly; GCal wins on
  times. If no calendar tool is connected, the agent asks about the day/week
  instead of guessing.
- **Dream is the only calendar WRITER.** The external GCal MCP is
  reads-only by policy; all event creation goes through Dream's plan flows.
  **[TARGET]** This split needs harder enforcement in instructions — in real
  use the agent didn't know Dream makes the calendar items.
- **Dream's `calendar_event` rows are async write jobs, never availability.**
  Each row is a pending push to GCal plus bookkeeping (`pushed_at`,
  `push_failed_at`, `push_error`, `completed_at`). `pushPendingEvents()`
  runs best-effort after each plan write; the daily heartbeat retries failed
  pushes. Planner context deliberately returns NO availability data — only a
  `calendarNote` pointing at the live calendar.
- Events land on a dedicated **"dream" calendar**, found-or-created per
  connected account (`ensureDreamCalendar`). OAuth binds whichever Google
  account approves the consent screen — *not* the client ID — which caused a
  real prod incident (events pushed to the wrong account's calendar). The
  connected account should be visible in the dashboard **[TARGET, backlog
  CAL-2]**.
