import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createRecordChangeSet,
  getRecordChangeSetByMarker,
  reviseRecordChangeSet,
} from "../services/recordChangeSets";
import { VersionedModelSchema, type VersionedModel } from "../services/records";
import { listRecords, readConversationSlice, readRecord, searchAllRecords } from "../services/recordReads";
import { prioritizeContext } from "../services/prioritize";
import { weeklyPlanContext } from "../services/weeklyPlan";
import { DailyPlanInputSchema, createDailyPlan, dailyPlanContext } from "../services/dailyPlan";

// The single persistent Dream MCP surface. No codes, no auth ceremony: the
// server is the user's own. Five conversational flows share these tools;
// planning tools arrive in later phases.

export const DREAM_SERVER_INSTRUCTIONS = `
This is Dream — the user's personal life-organization system. You help them
turn rants into records and read their own context back. Rules that always
apply:

1. DIGEST, don't interview. record_create is invoked at the END of a
   conversation (any conversation — long self-rant or quick capture). Digest
   everything said so far into the proposed record set. Ask at most 2-3
   decision-critical questions; an intake questionnaire is a failure.
2. Reading is an explicit user act, in two steps. Never read until the user
   asks you to pull something down. Step 1: list_records (cross-model
   search — "working on a workout habit" → the related goals, habits, ideas
   together). Step 2: read_record on the one they pick — that pulls the
   full relation web AND the originating rant into context.
3. Search before proposing. Before record_create, use list_records to find
   existing related records; propose links to THEIR records conversationally
   ("I found your goal 'higher agency' — is this related?"). The user's
   confirmation plus their explanation becomes the link's description (the
   "why", kept near-verbatim in their words).
4. Evidence rule: every field and satellite must trace to something actually
   said. Uncertainty goes in audit_note, not into invented fields.
5. Stubs are fine. A thin record is an invitation to branch later; the
   version chain is the specification process. Do not pad.
6. Linkage-depth invariants for goal-rant satellites: an environment_item is
   only created attached to a habit (goal ← habit ← environment); a task or
   project only attached to an experiment_idea. If the chain isn't in the
   conversation, don't create the satellite.
7. An answered question is NOT a go-ahead. Summarize the final record set in
   conversation and wait for an explicit yes before calling record_create.
8. After record_create: say the set was SUBMITTED FOR REVIEW in the
   dashboard — never that anything was created/applied. Include the returned
   marker token on its own line (it stitches this conversation to the
   records when the user later imports their chat export).
9. Update vs remix, when the user expands on an existing record: expanding/
   detailing the same thing = say "this looks like a v2 of X" ; a spin-off/
   combination = say "this is a remix derived from X". State your reading,
   let the user veto; the dashboard reviewer classifies finally.
10. Call get_survey for the model you're about to create — it lists exactly
    what to collect from the conversation and which links matter.
`.trim();

const SURVEYS: Record<VersionedModel, string> = {
  organized_goal: `
GOAL survey (the primary flow — run at the end of a self-rant):
- title: short name for the goal.
- description: what this means to the user and why, in their words (identity,
  motivation). This is planning fuel — capture it faithfully.
- Satellite sweep of the whole rant (each its own create op + link):
  * every BAD HABIT mentioned → habit satellite + goal_habit link whose
    description says how it blocks the goal / why removing it is the goal.
    DISAMBIGUATION: habit = a behavior that ALREADY EXISTS today (almost
    always bad). A proposed NEW recurring behavior ("compliment a stranger
    weekly") is an experiment_idea, NOT a habit — regardless of phrasing;
    it only becomes a real habit when a weekly plan establishes it.
  * every improvement idea → experiment_idea satellite + idea_goal link with
    the why on it.
  * every pattern of behavior → pattern_of_behavior satellite (ONE
    description covering trigger, emotion, coping mechanism, feedback loop)
    + goal_pattern link.
  * environment factors ONLY when tied to a specific habit → environment_item
    with habitLineageId (temp ref ok) + effect easier|harder.
  * tasks/projects ONLY when tied to an experiment idea.
- Multiple goals in one rant are fine: one central, others satellite.`,
  habit: `
HABIT survey (conversation-origin habits are almost always bad habits):
- A habit is a behavior that ALREADY EXISTS today. A proposed new recurring
  behavior is an experiment_idea instead, no matter how habit-like it sounds.
- title, description (what the habit is, when it shows up).
- Which goal is it part of removing/changing? → goal_habit link, description
  = the why in the user's words.
- Environment factor making it easier/harder? → environment_item satellite
  attached via habitLineageId.`,
  environment_item: `
ENVIRONMENT survey (only ever attached to a habit):
- title, description (the factor: a friend, the messy room, a standing
  commitment).
- habitLineageId: WHICH habit it affects (required; temp ref ok).
- effect: easier | harder — whether this factor makes THE HABIT easier or
  harder to do (not the goal).`,
  project: `
PROJECT survey (long-running thing to build):
- title, description (scope, what done looks like).
- Which experiment ideas relate? → idea_project links (projects reach goals
  only through ideas).`,
  experiment_group: `
EXPERIMENT GROUP survey (built from ideas; usually via read_record first):
- title, theme (the coherent monthly theme, one line), description (the
  reasoning: why these ideas harmonize toward these goals — read the
  idea_goal whys).
- group_idea links to every member idea.
- group_habit links to the bad habits being eliminated.
- group_goal links: seed from the UNION of member ideas' goal links, then
  curate + rank with the user (rank 0 = top priority).`,
  experiment_idea: `
EXPERIMENT IDEA survey (ambition — by definition not yet done; one-liner ok):
- title, description (the idea; readiness/fear context worth keeping goes
  here too).
- Which goals does it serve? list_records first; each confirmed goal →
  idea_goal link whose description is the user's why, near-verbatim.
- Does it concretize into a task or project mentioned here? → attach
  (task.experimentIdeaLineageId / idea_project link).
- Quick capture from a blank thread ("log an idea: try tennis") is valid:
  create thin, one goal question max.`,
  pattern_of_behavior: `
PATTERN OF BEHAVIOR survey:
- title (name the pattern).
- description: ONE prose description covering trigger (what sets it off),
  emotion (what it feels like), coping mechanism (what they do), and the
  feedback loop (how it sustains itself).
- Which goal(s) does it explain? → goal_pattern link, or none (dangling ok).`,
  task: `
TASK survey (one-off responsibility):
- title, description (details needed to execute).
- deadlineDate when one exists (YYYY-MM-DD) — drives planner nagging.
- experimentIdeaLineageId ONLY if the conversation established an idea
  behind it (goal-minded task); otherwise it is a plain errand. Confirm the
  absence explicitly rather than inventing meaning.`,
  leisure_activity: `
LEISURE survey (things the user likes — intentional rest fuel):
- title, description: MUST state the feeling-pairing in plain text ("for
  when I'm overwhelmed: a run and incense") — planners match mood to
  activity from this row alone.
- fitsWhen: when it fits (morning / evening / weekend...).
- counteractsPatternLineageId if a pattern was named (provenance only).`,
};

const OPERATION_CONTRACT = `
record_create operations contract:
- create op: {op:"create", tempId, model, role:"central"|"satellite",
  fields:{title, description?, ...model-specific}}. Exactly ONE central.
- link op: {op:"link", relation, from, to, description?, rank?} where
  relation ∈ idea_goal | goal_habit | goal_pattern | idea_project |
  group_idea | group_habit | group_goal, and from/to are "temp:<tempId>" or
  an existing lineageId. Link direction: idea_goal idea→goal ·
  goal_habit goal→habit · goal_pattern goal→pattern · idea_project
  idea→project · group_idea group→idea · group_habit group→habit ·
  group_goal group→goal (rank = priority order).
- Reference fields (environment_item.habitLineageId,
  task.experimentIdeaLineageId, leisure_activity.counteractsPatternLineageId)
  accept "temp:<tempId>" too.
- pick op (prioritize decisions only): {op:"pick", group, endDate:
  "YYYY-MM-DD", reasoning}. At most one; may stand alone or ride with the
  creates of a new group (group: "temp:<tempId>").
`.trim();

function resultText(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errorText(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createDreamMcpServer(): McpServer {
  const server = new McpServer({ name: "dream", version: "2.0.0" }, { instructions: DREAM_SERVER_INSTRUCTIONS });

  server.registerTool(
    "get_survey",
    {
      title: "Get the survey for a model",
      description:
        "Read the per-model survey before record_create: exactly what to collect from the conversation, which satellites to sweep, and which links matter. Also returns the operations contract.",
      inputSchema: { model: VersionedModelSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ model }) => resultText({ model, survey: SURVEYS[model].trim(), operations_contract: OPERATION_CONTRACT }),
  );

  server.registerTool(
    "list_records",
    {
      title: "Search records (step 1 of reading)",
      description:
        "Fuzzy-search the user's records. Without a model, searches ACROSS all models at once — 'working out' returns the matching goals, habits, experiment ideas, etc. together so the user can pick which to read. With a model, lists/searches only that model. Use when the user asks to pull something down without naming the exact record, and ALWAYS before record_create to find existing records to link instead of duplicating.",
      inputSchema: {
        model: VersionedModelSchema.optional(),
        query: z.string().trim().max(300).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ model, query, limit }) => {
      const results = model ? listRecords(model, query, limit ?? 50) : searchAllRecords(query ?? "", limit ?? 8);
      const empty = Array.isArray(results) ? results.length === 0 : Object.keys(results).length === 0;
      return resultText({ results, note: empty ? "no matches — nothing exists yet for this query" : undefined });
    },
  );

  server.registerTool(
    "read_record",
    {
      title: "Read one record with its typed relation web",
      description:
        "Step 2 of reading: pull down ONE record by lineage id — its version chain, branch parentage, per-model relations (a goal pulls its habits/patterns/ideas with whys and groups; a group pulls member ideas with done-states and its ranked goal set; a task pulls its idea and calendar items; etc.), AND the originating rant inline (the conversation slice that created it, once imported). Only when the user explicitly asks.",
      inputSchema: { model: VersionedModelSchema, lineage_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ model, lineage_id }) => {
      const record = readRecord(model, lineage_id);
      return record ? resultText(record) : errorText(`${model} ${lineage_id} not found`);
    },
  );

  server.registerTool(
    "read_conversation_slice",
    {
      title: "Read the rant behind a record",
      description:
        "Second-level zoom-in: read the actual conversation slice a record came from (conversation ids come from read_record's conversationSlices). Use when the user wants the original context, not by default.",
      inputSchema: { conversation_id: z.string().min(1), slice_end_idx: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ conversation_id, slice_end_idx }) => {
      const slice = readConversationSlice(conversation_id, slice_end_idx ?? null);
      return slice ? resultText(slice) : errorText("conversation not found or not yet imported");
    },
  );

  server.registerTool(
    "prioritize_context",
    {
      title: "Load the prioritize landscape (monthly decision)",
      description:
        "Run when the user wants to prioritize — pick the experiment group for the next couple of months (usually because no current pick exists or it expired). Returns every candidate group with its theme, ranked goal set, idea counts and done-states, plus the current/expired pick. Drive an echo-back brainstorm: reflect what you see, let the user rant, organize, repeat — then converge on ONE group and an end date (translate it: '8 weeks → N weekly plans — realistic?'). Submit the decision via record_create with a {op:'pick', group, endDate, reasoning} operation (the group may be an existing lineageId or a temp ref to a group created in the same change set). If an expired pick's group is unfinished, offer branching it to a v2 (read_record → remix/version) so the next pick starts where the last left off.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => resultText(prioritizeContext()),
  );

  server.registerTool(
    "weekly_plan_context",
    {
      title: "Load the weekly-plan context",
      description:
        "Run when the user wants to plan their week. Returns the current pick (deadline clock: weeks elapsed/remaining), the full group read (member ideas + done-states, ranked goals with whys), ALL prior weekly plans of this pick with item completions, open deadline tasks, and the leisure list. OPEN the conversation with the state of play — week N of M, last week's completions, the big-ticket position — THEN ask capacity/readiness. Momentum rules: stack wins, start tiny, build up; push back with the deadline when the user defers ('3 weeks left — ok failing this week?'). Schedule ONLY habit blocks being established and must-anchor blocks; everything else becomes items (todo|intention) for the daily planner. Submit via record_create with ONE {op:'create_weekly_plan', weekOf (Monday), theme, description (weekly goal + reported state), items, habitStarts, anchoredEvents, ideasDone} operation after the explicit go-ahead.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => resultText(weeklyPlanContext()),
  );

  server.registerTool(
    "daily_plan_context",
    {
      title: "Load the daily-plan context",
      description:
        "Run when the user wants to plan tomorrow (or today). Returns the CURRENT weekly plan only (with item completions), the last ~7 daily plans (their reported states and completions — yesterday's exhaustion is tomorrow's leisure budget), open tasks with deadlines (unanchored deadline tasks are the DAILY NAG: raise them every day until scheduled), the leisure list (match activities to the reported mood via their feeling-pairing descriptions), the standing work context, and what is already scheduled on the date. OPEN with the date's reality (calendar + recent state), then ask the fixed three: energy level? social urge? how heavy is work? Then propose: a work-centric theme one-liner, the day's blocks — including INVENTED ones (make-breakfast, a 1pm walk, an ask-your-boss note) and leisure matched to the state — and drain weekly todos into the day.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    },
    async ({ date }) => resultText(dailyPlanContext(date)),
  );

  server.registerTool(
    "create_daily_plan",
    {
      title: "Write the confirmed daily plan (conversation IS the review)",
      description:
        "Unlike record_create, this writes DIRECTLY: for daily plans the in-conversation confirmation is the review, so call it only after the user explicitly confirms the proposed day. Creates the plan (theme + description carrying the reported energy/social/work state for tomorrow's planner), its items (block|todo|leisure; items with startAt/endAt become scheduled events, pushed to Google Calendar when connected), and links deadline tasks via taskLineageId. Tell the user it is on their calendar/plan — this one IS applied.",
      inputSchema: DailyPlanInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async input => {
      try {
        const plan = createDailyPlan(input);
        return resultText({ status: "created", plan });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "create_daily_plan failed");
      }
    },
  );

  server.registerTool(
    "record_create",
    {
      title: "Submit one digested change set for dashboard review",
      description:
        "The ONLY way records are born. Call at the end of a conversation, after the user's explicit go-ahead, with the fully digested set: one central create + satellites + why-bearing links (see get_survey). Nothing is created now — the set goes to the dashboard review inbox where the user applies or rejects it. Repeat the returned marker token in your reply.",
      inputSchema: {
        summary_md: z.string().trim().min(1).max(40_000).describe("What this change set is and why, grounded in the conversation"),
        operations: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
        audit_note: z.string().trim().min(1).max(4_000).optional().describe("Unresolved uncertainty for the reviewer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ summary_md, operations, audit_note }) => {
      try {
        const cs = createRecordChangeSet({ summaryMd: summary_md, operations, auditNote: audit_note });
        return resultText({
          status: "submitted_for_review",
          marker_token: cs.markerToken,
          change_set_id: cs.id,
          note: "Submitted to the dashboard review inbox. Nothing exists until the user applies it there. Repeat the marker token in your reply so the conversation export can be stitched to these records.",
        });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "record_create failed");
      }
    },
  );

  server.registerTool(
    "check_review_status",
    {
      title: "Check a submitted change set",
      description:
        "Read the status of a change set by marker token. If the dashboard sent it back with feedback (status drafting + rejectionNote), treat the feedback as the user's newest instruction and revise_record_create.",
      inputSchema: { marker_token: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ marker_token }) => {
      const cs = getRecordChangeSetByMarker(marker_token);
      if (!cs) return errorText("no change set with that marker token");
      return resultText({ status: cs.status, feedback: cs.rejectionNote, appliedRecords: cs.appliedRecords });
    },
  );

  server.registerTool(
    "revise_record_create",
    {
      title: "Revise a returned change set",
      description:
        "After the dashboard sent a change set back with feedback, submit the revised operations. Same change set, same marker token — never start a new one for a revision.",
      inputSchema: {
        marker_token: z.string().min(1),
        summary_md: z.string().trim().min(1).max(40_000),
        operations: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
        audit_note: z.string().trim().min(1).max(4_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ marker_token, summary_md, operations, audit_note }) => {
      const existing = getRecordChangeSetByMarker(marker_token);
      if (!existing) return errorText("no change set with that marker token");
      try {
        const cs = reviseRecordChangeSet(existing.id, { summaryMd: summary_md, operations, auditNote: audit_note });
        return resultText({ status: "resubmitted_for_review", marker_token: cs.markerToken });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "revision failed");
      }
    },
  );

  return server;
}
