# Agent and MCP principles

*Written 2026-07-22, post PR #6. How agents are allowed to touch Dream, why
the surface is shaped the way it is, and where observed behavior falls short
of the rules. Status tags ([TARGET], [UNCERTAIN], [DECISION OPEN]) as defined
in `docs/product/dream-product-model.md`.*

The authoritative agent-facing text is `DREAM_SERVER_INSTRUCTIONS` (rules
1–11), the per-model `SURVEYS`, and the `OPERATION_CONTRACT`, all in
`backend/src/mcp/dreamServer.ts`. This document explains the principles
behind them; when editing behavior, change that file and keep this one in
sync.

## 1. Human-in-the-loop rules (the review membrane)

- One `record_create` call = one **change set**: exactly one central create
  (or one `pick` / one `create_weekly_plan`), plus satellite creates and
  links wired with `temp:<tempId>` references. Validated in
  `backend/src/services/recordChangeSets.ts` (`validateOperations`).
- A change set never applies itself. It lands as a `draft_change_set` row in
  the dashboard **review inbox** (`dashboard/src/screens/ReviewInbox.tsx`,
  API in `backend/src/api/routes/review.ts`). An AI reconciliation pass
  (`reconcileRecordChangeSet`, runnable on Anthropic API or Bedrock) suggests
  per-record verdicts: **new**, **version_bump{ofLineageId}**,
  **remix{parents[]}**, or **link_existing{lineageId}**. The human's verdict
  overrides always win at apply time.
- The agent must say the set was **"submitted for review"** — never
  "created" — and must print the returned marker token (`rc_<12hex>`) on its
  own line, which later stitches the exported conversation to the applied
  records.
- The single exception: `create_daily_plan` writes directly, because the
  daily conversation's explicit confirmation *is* the review (spec §8a).
- Rejection is a round-trip: `rejectRecordChangeSet` returns the set to
  drafting with feedback; `revise_record_create` resubmits under the same
  marker.

## 2. Always propose and echo the complete change set before writes

The rule, in the user's words: **"always echo back your understanding of me
and the goal and all other foreign key records being created in the change
set before you actually make the record, so we can work together on it."**
Corollaries already codified as rules 1, 3, and 7: digest don't interview; an
answered question is NOT a go-ahead; summarize the final record set and wait
for an explicit yes.

Observed reality (post-merge review): the MCP is **way too eager to write**.
It created records without echoing first, twice, in real usage. The whole
point of a conversational surface is the back-and-forth brainstorm before the
write. **[TARGET — backlog MCP-1]** Enforcement must get stronger than a
buried instruction line: the echo-back must cover the central record, *every*
satellite and link (the full FK web), and the user's goal as understood —
and the dry-run harness must test for premature writes specifically.

## 3. Reusing existing records and foreign keys

Mechanics that exist today:

- Relationships reference **lineage ids**, and link ops accept either
  `temp:<tempId>` or an existing lineage id — so a change set *can* link
  brand-new records to existing ones in one shot.
- Reference fields (`environment_item.habitLineageId`,
  `task.experimentIdeaLineageId`, `leisure_activity.counteractsPatternLineageId`)
  accept temp refs too.
- Rule 3: search (`list_records`) before proposing; confirmed links carry the
  user's why, near-verbatim, as the link description.
- Remixes support **multiple parents** (`lineage_parent` is many-to-many) —
  a remix can have multiple inspirations by design.

Observed gaps **[TARGET]**:

- **One-change-set group creation over existing ideas failed in practice**
  (backlog MCP-2): asked to make a group linking existing experiment ideas,
  the agent had the group approved first and then proposed links separately.
  The machinery supports doing it in one change set; the instructions/surveys
  don't teach pulling existing records' lineage ids into the same set firmly
  enough.
- **Pending change sets aren't first-class readable** (backlog MCP-3): the
  agent may need to read a proposed (not yet applied) change set back, update
  it, or reference its records in new relationships.
  `check_review_status` / `revise_record_create` exist but only round-trip
  status and full resubmission.
- **link_existing should be a user-editable set** (backlog MCP-4): the
  reviewer should see all AI-found candidates and add/remove from that set to
  "minor-approve" it, rather than accepting one suggestion.
- **Similarity noting** (backlog MCP-6): near-duplicate records (e.g.
  "Overcome perfectionism / fear-based blocking…" vs "Build process-based
  confidence…") need a recordable "these are similar" note an agent can read
  to do maintenance later. **[DECISION OPEN: relation row vs description
  convention.]**

## 4. Read versus write source-of-truth boundaries

| Concern | Source of truth for READS | Who WRITES |
|---|---|---|
| Calendar availability | Live Google Calendar, via the user's external GCal MCP (rule 11) — never Dream rows | — |
| Calendar events | (same) | **Dream only** (plan flows → `calendar_event` write jobs → push). External GCal MCP is reads-only by policy |
| Rants / conversation text | `read_record` (inlines the originating rant) and `read_conversation_slice`, on explicit user ask only (rule 2) | Conversation import (admin) |
| Record content | `list_records` → `read_record` two-step | Review-membrane apply only; insert-only versioning |
| Plan state (done, expired, current) | Timestamps + lineage heads — no status enums | Manual dashboard toggles; `pick` end dates |
| Yesterday's reported state | The prior daily plan's `description` | The daily plan write |

Planners never read rants. Dream's own `calendar_event` rows answer exactly
one read question: "has a write job been created for this task yet?" — the
daily nag's `anchored` flag. Everything else calendar-shaped is a live read.

## 5. When specialized tools beat generic CRUD

The current surface is deliberately **shaped**: 11 tools, each carrying a
survey (what to collect), a contract (what a valid op set looks like), and
conversational guidance (how to open, when to push back). That shaping is
what makes a generic chat agent behave like it understands the system —
`get_survey` and the operation contract are the spec, delivered at the moment
of use.

**[DECISION OPEN — backlog MCP-7]** The review notes float a general-purpose,
heavily human-in-the-loop CRUD MCP for bookkeeping the shaped tools don't
cover — *"think if this is an anti-pattern and simply making our access
patterns better is a better idea."* Unresolved. Note the adjacent but
distinct idea: an **admin MCP** for environment inspection
(prod/staging record reads for agents) is an infrastructure concern and lives
in `docs/architecture/environments-and-delivery.md` §6 — don't conflate the
two when deciding.

## 6. Conversation friction → MCP improvement tickets **[TARGET]**

The improvement loop the review notes demand: *"there has to be a system to
boil down conversation usage interactions with the Dream MCP into actual MCP
improvements."* Shape:

1. **Export** real Claude conversations that used the Dream MCP (the
   conversation-import parser already reads exported JSON including typed
   `tool_use`/`tool_result` blocks, and marker tokens identify which
   conversations touched Dream — `backend/src/services/provenance.ts`,
   ingestion under `backend/src/services/ingestion.ts`).
2. **Analyze** them for friction signals: what the user yells at the agent
   about, what the user has to explicitly instruct that the MCP should have
   known, premature writes, missed echo-backs, wrong tool choices.
3. **Emit tickets**: structured MCP-improvement items an agent (or Daren) can
   act on — ideally appended to `docs/backlog/` in the same format as
   `post-merge-review.md`.

Every behavior item in the current backlog (MCP-1, MCP-2, MCP-8…) was
produced by exactly this loop, run manually. The pipeline automates it.
**[UNCERTAIN: where the analysis runs — a script + AgentRunner prompt, a
dedicated MCP, or an ad-hoc agent session. Sequencing note: build after the
environments groundwork, since it wants a safe place to read real data.]**
