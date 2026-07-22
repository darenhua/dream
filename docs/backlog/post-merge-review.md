# Backlog: post-merge review (PR #6)

*Written 2026-07-22. Every concrete note from Daren's post-merge review,
converted to structured items. Types: **bug** (observed wrong behavior),
**product** (new/changed behavior), **infra** (shipping groundwork),
**decision** (needs a call before work starts). Meta-directive governing
sequencing: "I don't JUST want actual fixes, I want groundwork laid so that
this fix and future fixes are easier" — infra items come first; see
`docs/handoffs/post-large-pr.md` §5 for the recommended order.*

*Format: each item has a statement, acceptance criteria (AC), and code links.
Items marked [UNCERTAIN] carry an interpretation to confirm.*

---

## Infrastructure

### INFRA-1 · infra · Migration + snapshot strategy, scripted
The discipline (additive-only, WAL-safe `.backup`, rehearse-on-prod-copy) is
convention only; encode it in scripts and the deploy flow.
**AC:** `snapshot`/`restore` scripts exist with prod guards; prod deploy
takes an automatic pre-migration snapshot; a daily backup cron is documented
for the VM; a migration rehearsal step (restore prod copy → boot → smoke)
exists and is part of the promotion path.
**Code:** `backend/src/db/index.ts` (`runMigrations`), `backend/drizzle/`,
new `scripts/`.

### INFRA-2 · infra · Staging environment beside prod
Staging on the same VM: own `DB_PATH`, own ports, own MCP URL, latest `main`.
**AC:** staging boots independently of prod; nuking/seeding staging cannot
touch prod's DB; smoke script passes against it; documented in the runbook.
[UNCERTAIN: second pm2 app pair assumed — confirm process layout.]
**Code:** `backend/src/api/server.ts` (PORT/DB_PATH/PUBLIC_URL driven),
`deployment.md` env table.

### INFRA-3 · infra · Staging auto-deploys on every merge to main
**AC:** a merge to `main` redeploys staging with zero manual steps;
migrations apply at boot; smoke runs and failures notify; staging therefore
continuously tests redeployment + data-migration issues.
**Code:** new `.github/workflows/`, VM-side deploy script (SSH or poller —
see `RECAP.md` git-poller artifacts).

### INFRA-4 · infra · Prod deploys tagged commits only
**AC:** pushing a release tag (or an explicit promote command) deploys prod:
snapshot → checkout tag → restart pm2 apps → smoke; rollback documented
(checkout previous tag + restore snapshot); no manual git-pull-and-restart
remains in the runbook.
**Code:** same workflow/scripts as INFRA-3.

### INFRA-5 · infra · Maintenance script library
`seed`, `fixtures`, `snapshot`, `restore`, `smoke`, `nuke` per the contracts
in `docs/architecture/environments-and-delivery.md` §4.
**AC:** each script exists, is documented, works on local + staging;
destructive scripts hard-refuse the prod `DB_PATH` without an explicit flag;
`seed` produces a DB where the dashboard, planners, and review inbox all
demo end-to-end.
**Code:** new `scripts/`; fixture data shaped by
`backend/src/services/records.ts` MODELS + `SCHEMA_AND_SURVEYS.md`.

### INFRA-6 · infra · Local + ephemeral-VM dev parity
**AC:** a fresh clone (laptop or cloud coding session) reaches a running,
seeded stack with one documented command sequence; no undocumented env vars;
the verification loop (backend tsc → scratch-DB tests → dashboard build) is
written down where agents will find it.
**Code:** `README`/runbook additions, `scripts/seed`, possibly a
SessionStart hook for cloud sessions.

### INFRA-7 · decision · PR ↔ staging relationship
Are PRs deployed to staging (or per-PR instances)? How does an agent on the
VM work against a PR's branch? Blocked on INFRA-2/3 existing first.
**AC (for the decision):** a written call in this file's changelog + the
environments doc updated.

---

## MCP behavior

### MCP-1 · bug · Echo-back before writes is not enforced
Observed twice: the MCP is "way too eager" to create records / with its
writes. Required behavior: always echo back the understanding of the user,
the goal, and ALL other FK records in the change set before `record_create`;
brainstorm back-and-forth is the point of the chat surface.
**AC:** instructions restructured so the echo-back is a hard precondition
(not one line in a list); covers every satellite + link; the dry-run harness
includes a "did it write before an explicit yes after a full echo?" check
and passes; subsequent real usage shows no premature writes.
**Code:** `backend/src/mcp/dreamServer.ts` (`DREAM_SERVER_INSTRUCTIONS`
rules 1/3/7, `record_create` tool description).

### MCP-2 · bug · One change set can't group existing ideas (in practice)
Asked for a group linking EXISTING experiment ideas, the agent approved the
group first, then proposed links separately. The op contract supports link
ops to existing lineage ids in the same set — the instructions don't teach
reading/pulling existing records' FKs into one change set firmly enough.
**AC:** dry-run "make a group from these N existing ideas" yields ONE change
set: group create + `group_idea` links to existing lineage ids +
union-seeded `group_goal` links; verify `validateOperations`/apply handles
it; survey text updated.
**Code:** `backend/src/services/recordChangeSets.ts`,
`dreamServer.ts` `SURVEYS.experiment_group` + `OPERATION_CONTRACT`.

### MCP-3 · product · Read/update proposed change sets; use them in relationships
The agent may need to read a pending change set back into context, update
it, or reference its not-yet-applied records.
**AC:** an MCP path exists to fetch a pending set's full ops by marker token;
`revise_record_create` documented as the update path; a decision recorded on
whether pending records can be link targets (or explicitly ruled out).
**Code:** `recordChangeSets.ts` (`getRecordChangeSetByMarker` exists
server-side), `dreamServer.ts` (`check_review_status`,
`revise_record_create`).

### MCP-4 · product · link_existing as an editable candidate set
Reviewer should multi-select from ALL AI-found candidates — add/remove from
the set to "minor-approve" it.
**AC:** reconciliation returns candidate lists (it does); the Review Inbox
UI presents them as a checkable set per record; apply honors the edited set.
**Code:** `backend/src/services/recordChangeSets.ts`
(`reconciliationCandidates`, verdict overrides),
`backend/src/api/routes/review.ts`,
`dashboard/src/screens/ReviewInbox.tsx`.

### MCP-5 · product · Multi-inspiration remixes surfaced end-to-end
`lineage_parent` already supports multiple parents; the review UI and MCP
language must let a remix cite several inspirations.
**AC:** reviewer can select multiple parents for a remix verdict; applied
rows show all parents in `read_record`'s envelope.
**Code:** `recordChangeSets.ts` (remix verdict), `recordReads.ts`
(parents in envelope — exists), `ReviewInbox.tsx`.

### MCP-6 · product · Similarity notes for record maintenance
Near-duplicates ("Overcome perfectionism…" / "Build process-based
confidence…") need a recorded similarity an agent can read to do
maintenance. [DECISION inside: mechanism — a relation row vs a description
convention vs reconciliation output persisted.]
**AC:** a similarity can be recorded, surfaced in `read_record`, and listed
so a maintenance agent can enumerate candidates.
**Code:** `backend/src/db/schema.ts`, `recordReads.ts`, reconciliation in
`recordChangeSets.ts`.

### MCP-7 · decision · General-purpose HITL CRUD MCP — or better access patterns
The review notes propose it and, in the same breath, ask whether it's an
anti-pattern. Related but distinct: the admin/inspection MCP for
environments (see `environments-and-delivery.md` §5) — decide both, and
decide whether they're the same deployment.
**AC (decision):** written call covering scope, HITL gates, and deployment
shape.

### MCP-8 · bug · Enforce the GCal-reads / Dream-writes split harder
The agent didn't know Dream makes the calendar items; the external Google
Calendar MCP is reads-only by policy.
**AC:** instructions state Dream is the ONLY calendar writer, prominently
(rule 11 covers reads; add the write half); planner tool descriptions repeat
it; dry-run confirms the agent routes writes through Dream and reads through
the GCal MCP.
**Code:** `dreamServer.ts` rule 11 + `weekly_plan_context` /
`daily_plan_context` / `create_daily_plan` descriptions.

### MCP-9 · infra · Conversation-friction → improvement-ticket pipeline
Export chats that used the Dream MCP, analyze for friction (yelling,
explicit corrections, premature writes), emit structured tickets.
**AC:** run against a real export batch, produces a ticket list in the
backlog format; false-positive rate acceptable to Daren; documented rerun
path. Sequencing: after environments groundwork (needs a safe data home).
**Code:** `backend/src/services/provenance.ts`, ingestion/parser services,
`agentRunner.ts` for the analysis pass.

---

## Planning product

### PLAN-1 · product · Mindset themes for weekly and daily plans
Themes must be vague/general/mindset-focused one-liners with a why tied to
goals and patterns — contextualizing every micro-decision (the Andre 3000
standard; full articulation in `docs/product/dream-product-model.md` §4).
**AC:** theme guidance embedded in `weekly_plan_context` /
`daily_plan_context` descriptions (incl. the litmus test: affects one
decision ⇒ task, not theme; concrete handle goes in the description);
dry-run themes pass the litmus test; daily themes relate to the week's
theme.
**Code:** `dreamServer.ts` planner tool descriptions; `theme` columns
already exist (`experiment.theme`, `daily_plan.theme`);
`CONVERSATION_FLOWS.md`.

### PLAN-2 · bug · Daily planner never asks about leisure and bandwidth
Observed: the daily planning conversation asked neither.
**AC:** the daily flow asks bandwidth/capacity and leisure alongside
energy/social/work; proposed plans include leisure items when the user has
appetite; dry-run verifies the questions occur.
**Code:** `dreamServer.ts` `daily_plan_context` description,
`backend/src/services/dailyPlan.ts` (leisure list is already in context),
`CONVERSATION_FLOWS.md`.

### PLAN-3 · product · Collect leisure stubs inside the daily conversation
The daily convo is a natural moment to capture new leisure activities.
**AC:** a defined flow (survey text + tool path) for creating thin
`leisure_activity` records from the daily conversation without derailing it
[UNCERTAIN: via a small record_create set vs a direct mechanism — the
daily flow is otherwise review-exempt].
**Code:** `dreamServer.ts` `SURVEYS.leisure_activity`, daily flow docs.

### PLAN-4 · product · Improve stub-creation flows generally
"Making stubs in general isn't quite a great flow" — under-specified by the
source note; needs definition with Daren before work.
**AC (first step):** a short written diagnosis of where stub creation is
awkward (quick capture, satellites, leisure) and the proposed fix list.

### PLAN-5 · product · One-pager context docs per day/week/month plan
Growing list of readable/chattable one-pagers attached to plans; plans stay
immutable, context evolves (guitar-triads example). [DECISION inside:
storage — new record model vs files vs config.]
**AC:** one-pagers can be created/read from conversation and dashboard,
attached to a specific plan; the daily planner and "doing current task" flow
pull them; immutability of the underlying plans preserved.
**Code:** new model in `backend/src/db/schema.ts` + reads in
`recordReads.ts` (if record-shaped); `PlanBoard.tsx`.

### PLAN-6 · product · "Doing current task" MCP flow
Open with "ugh I don't want to do this task" → agent pulls current GCal
event (via external GCal MCP), resolves the Dream task, reads its
description, pulls the owning daily/weekly plan parts + one-pagers, and
talks the user through it.
**AC:** a tool (or documented tool sequence) resolves
current-calendar-event → task → plan context; dry-run demonstrates the flow
end-to-end. Depends on PLAN-5 for one-pagers but useful before it.
**Code:** `dreamServer.ts` (new tool), `dailyPlan.ts`/`weeklyPlan.ts`
context reads, `calendar_event.entityId` mapping.

---

## Accountability

### ACC-1 · product · Weekly-plan recap messages to friends (primary)
On new weekly plan creation: "Daren finished doing X — ask him how it went;
he's going to start doing Y," plus ONE interesting conversation starter
about the goal/idea.
**AC:** recap generated from the prior week's completions + the new week's
items; delivered to a configured friend list; content approved by Daren
before send (HITL) at least initially. [UNCERTAIN: transport — outbox/
messaging services exist but the messenger switch was never finished; see
`docs/messenger-local-switch.md`.]
**Code:** `backend/src/services/weeklyPlan.ts` (`applyWeeklyPlan` emit
point), `outbox.ts`, `messaging/`, `witnesses.ts`.

### ACC-2 · product · Don't-quit escalation on missed daily plans
Missing more than 2 daily plans triggers messages to friends on an
exponential backoff. [UNCERTAIN: backoff reset semantics; whether "missed"
means no plan created or plan ignored.]
**AC:** miss detection defined off `daily_plan.date` gaps; backoff schedule
implemented and tested; messages HITL-approved initially.
**Code:** `backend/src/services/strikes.ts` (dormant strike machinery),
`daily.ts` heartbeat, messaging as ACC-1.

### ACC-3 · product · Support before big scary tasks
Visibility/support toward large risky ideas being attempted. Needs design
(what marks a task "big scary"; what the message asks of friends).
**AC (first step):** a one-page design agreed with Daren.
**Code:** likely `task`/`experiment_idea` description conventions +
messaging as ACC-1.

---

## Calendar integration

### CAL-1 · bug · "Sync now" is inbound-only
The dashboard sync button pulls from GCal but never retries failed/pending
pushes — during the prod incident this misled debugging.
**AC:** sync-now also clears `push_failed_at`/`push_error` and runs
`pushPendingEvents`; response reports pushed/failed counts.
**Code:** `backend/src/api/routes/calendar.ts`,
`backend/src/services/calendarSync.ts`, `calendarWriter.ts`
(the heartbeat sweep in `daily.ts` already does this shape).

### CAL-2 · product · Push-state and account visibility in the dashboard
**AC:** calendar panel shows pending/pushed/failed counts, surfaces
`push_error` text per failed row, and displays the connected Google
account's email (the prod incident was a wrong-account bind that nothing
surfaced).
**Code:** `dashboard/src/components/AdminDashboard.tsx`, calendar routes,
`google_auth` table.

### CAL-3 · bug · Offset timestamps rejected; raw-Z timezone trap
`z.string().datetime()` in plan inputs rejects `2026-07-23T07:40:00-04:00`;
and stored raw-Z times read as UTC (04:15Z is 12:15am ET — observed
confusion in prod).
**AC:** `.datetime({ offset: true })` accepted on daily/weekly plan items
and calendar writes; a timezone sanity instruction added to planner tool
descriptions (times echoed to the user in their local wall time);
storage convention documented.
**Code:** `backend/src/services/dailyPlan.ts` (`DailyPlanInputSchema`),
`weeklyPlan.ts` (`WeeklyPlanOpSchema` habitStarts/anchoredEvents),
`dreamServer.ts`.

### CAL-4 · infra · Snapshot-before-deploy + daily DB backup cron
Calendar-adjacent because the incident response leaned on DB inspection —
but this is INFRA-1's scope; tracked there. Cross-reference only.

---

## Dashboard UX

### DASH-1 · bug · Todo lists have no modals; titles truncated
**AC:** clicking a todo/plan item opens a modal showing at minimum the FULL
title (plus description and metadata); nothing user-entered is unreachable
in the UI.
**Code:** `dashboard/src/screens/PlanBoard.tsx`,
`dashboard/src/components/ui/`.

### DASH-2 · bug · Text overflow in cards is broken
**AC:** long titles/descriptions wrap or truncate with ellipsis + full text
available (via DASH-1 modal); no layout breakage at realistic content
lengths (seed fixtures from INFRA-5 should include long-text cases).
**Code:** `PlanBoard.tsx`, card components.

### DASH-3 · product · Plans must be glanceable
"At a glance I can't even remember what my daily plan and weekly plan are" —
descriptions absent from card bodies.
**AC:** daily and weekly plan cards show theme AND enough of the
description to recall the plan without clicking; the pick/weekly/daily
hierarchy readable on the board's first screen.
**Code:** `PlanBoard.tsx`, `backend/src/api/routes/organized.ts` (data is
already returned; this is presentation).
