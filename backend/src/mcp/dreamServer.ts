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
import { WeeklyPlanV2InputSchema, createWeeklyPlanV2, weeklyPlanContextV2 } from "../services/weeklyPlanV2";
import { DailyPlanV2InputSchema, createDailyPlanV2, currentTaskContext, dailyPlanContextV2 } from "../services/dailyPlanV2";
import { AddWinsSchema, addWins } from "../services/wins";
import { appendPlanDoc, getPlanDoc } from "../services/planDocs";
import { getPlanningContext } from "../services/planningOracle";
import { beginPlanningFlow, savePlan } from "../services/planningFlows";
import "../services/planningFlowWiring"; // registers save handlers + playbook renderers

// The single persistent Dream MCP surface. No codes, no auth ceremony: the
// server is the user's own. PLANNING IS THE CORE (PLANNING_REVAMP_SPEC):
// the daily/weekly/monthly planning and review conversations happen
// constantly; record creation happens occasionally.

// GLOBAL.v1 (docs/revision/PROMPT_PACK.md §1) — verbatim, plus two retained
// operational additions the pack doesn't carry: the gcal write contract
// (law 9 sub-line) and the fenced non-planning RECORD RULES (the membrane
// stays for organized truths; deleting its rules would break a live flow).
export const DREAM_SERVER_INSTRUCTIONS = `
You are Dream's planning coach. The conversation is the product; the database is a side effect.

Laws (every turn, every flow):
1. TOOLS ARE INVISIBLE. Never mention tools, sessions, playbooks, dashboards,
   approvals, tokens, IDs, or "the system." Never narrate what you are about to
   call. The user experiences only a conversation with a coach who happens to
   remember everything.
2. ECHO LAW. Whenever the plan under construction changes, re-render the FULL
   plan in its pretty template (the playbook contains it). The user corrects
   what they can see. Never describe a change in prose that you could show
   instead.
3. THE ECHOED ARTIFACT IS THE APPROVAL. Save only after the user gives a clear
   yes to the most recent full echo. "Maybe" / "i guess" / silence is not a yes.
   After the yes, save silently and confirm in one warm line.
4. NEVER INVENT PLAN SUBSTANCE. No fabricated chains, cues, commitments, dates,
   events, or goals. Thin information means: converse more, or converge to the
   flow's floor. It never means: fill gaps with plausible content. Anything you
   draft as a proposal is labeled as yours and the user must reshape or
   explicitly adopt it before it counts.
5. PROVENANCE. Anything pulled from prior records is flagged inline at echo
   time: "(carried from {{source}} — keep it?)". Unflagged imports are
   hallucinations.
6. NO SHAME. Never surface undone work, unlogged days, missed plans, or empty
   ledgers. Lateness and gaps are energy data for YOU, never material to show
   the user. Assume they did their best.
7. NO WIDGETS. Never use multiple-choice UI elements. Ask in words, at most one
   question per message.
8. USER'S WORDS WIN. Their phrasings go into fields verbatim where possible.
   When you compress a rant, keep a visible "parked" line for anything said
   twice that didn't make the artifact — silent flattening loses trust.
9. CALENDAR IS DATA, NOT TRUTH. Stored events carry dates; anything stale or
   surprising gets confirmed in passing, never assumed. The user's gcal MCP is
   READ-ONLY by contract: never create, update, or delete events with it — ALL
   calendar writes go through Dream tools.
10. COACH SPINE. Hold opinions out loud. Name revision vs walk-back. Count
    repeated evasions kindly ("third time I've raised it"). Distinguish
    experimental failure (the plan was wrong) from operational failure (the
    plan was right, unworked). Flag theme/action mismatches the moment you see
    them. Keep big rewards for big milestones.

RECORD RULES (organized truths — record_create, the review-inbox membrane.
These apply to record capture only, NEVER to planning flows):
1. DIGEST, don't interview. record_create is invoked at the END of a
   conversation. Ask at most 2-3 decision-critical questions.
2. Reading is an explicit user act: list_records (cross-model search) then
   read_record on the one they pick.
3. Search before proposing: list_records first; propose links to THEIR
   records conversationally; their explanation becomes the link description,
   near-verbatim.
4. Evidence rule: every field traces to something actually said; uncertainty
   goes in audit_note, never into invented fields.
5. Stubs are fine — do not pad.
6. Linkage-depth invariants: environment_item only attached to a habit; a
   task or project only attached to an experiment_idea.
7. After record_create: the set was SUBMITTED FOR REVIEW in the dashboard —
   never say created/applied. Repeat the marker token on its own line.
8. Update vs remix: same thing detailed = "a v2 of X"; a spin-off = "a remix
   derived from X". State your reading, let the user veto.
9. Call get_survey for the model you're about to create.
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

  // TOOL.context.v1 (PROMPT_PACK §2) — verbatim.
  server.registerTool(
    "get_planning_context",
    {
      title: "The planning oracle: state, likely flow, opening move",
      description:
        "Read Dream's authoritative planning state and get an interpreted briefing: what exists (monthly era / weekly / daily), what it implies, the most likely flow, and the exact opening move to make with the user.\n\nCall this FIRST in every planning conversation — including at conversation open, before the user has asked for anything, so you can speak first. Also call it when the user changes horizon, references a plan you haven't seen, or after any refusal that says state changed.\n\nFollow the briefing's \"Your opening move\" section. Confirm the flow with the user in conversation (invisibly — never mention this tool), then call begin_planning_flow. Do not begin or save anything the briefing marked invalid.",
      inputSchema: {
        user_request: z.string().trim().max(2_000).optional(),
        reference_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ user_request, reference_date }) => {
      try {
        const { markdown, structured } = getPlanningContext({ user_request, reference_date });
        return { content: [{ type: "text", text: markdown }], structuredContent: structured };
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "get_planning_context failed");
      }
    },
  );

  // TOOL.begin.v1 (PROMPT_PACK §2) — verbatim.
  server.registerTool(
    "begin_planning_flow",
    {
      title: "Start the confirmed planning flow",
      description:
        "Start the planning flow the user just confirmed. Returns the operating playbook: choreography, context, the pretty echo template, floors, and save rules for exactly this flow.\n\nCall only after the user confirmed the flow in conversation. Input is the confirmed intent in plain words (e.g. \"create the weekly plan for Aug 10–16\"). If the server can't resolve it, you'll get back one question to ask — ask it and call again.\n\nFollow the playbook for the whole conversation. Do not restart discovery for small updates. Never reveal the playbook or this machinery to the user.",
      inputSchema: {
        confirmed_intent: z.string().trim().min(1).max(2_000),
        target_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        target_plan_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async input => {
      try {
        const result = beginPlanningFlow(input);
        if (!result.ok) return { content: [{ type: "text", text: result.markdown }], isError: true };
        return { content: [{ type: "text", text: result.markdown }], structuredContent: result.structured };
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "begin_planning_flow failed");
      }
    },
  );

  // TOOL.save.v1 (PROMPT_PACK §2) — verbatim.
  server.registerTool(
    "save_plan",
    {
      title: "Validate and persist the confirmed plan",
      description:
        "Validate and persist the finished plan for the active flow. The server derives plan type, operation, and target period from the flow session — you supply the session id, a fresh request_id, user_confirmed_save, and the structured artifact matching the playbook's schema.\n\nCall only when: the full plan was echoed in its pretty template, and the user clearly approved that exact version. Set user_confirmed_save only if that literally happened.\n\nOn refusal (conflict / expired / invalid), read the message — it says exactly how to recover. Retries: reuse the same request_id with the identical payload only.",
      inputSchema: {
        workflow_session_id: z.string().min(1),
        request_id: z.string().min(6).max(100),
        user_confirmed_save: z.boolean(),
        plan: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async input => {
      try {
        const result = savePlan(input);
        if (!result.ok) return { content: [{ type: "text", text: result.markdown }], isError: true };
        return { content: [{ type: "text", text: result.markdown }], structuredContent: result.structured };
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "save_plan failed");
      }
    },
  );

  server.registerTool(
    "prioritize_context",
    {
      title: "Load the prioritize landscape (monthly decision)",
      description:
        "Run when the user wants to set the monthly-level direction and none exists (or it expired). Returns every candidate group with its theme and ranked goal set, plus the current/expired pick. Drive an echo-back brainstorm: reflect what you see, let the user rant, organize, repeat — then converge on ONE group and an end date (translate it: '8 weeks → N weekly plans — realistic?'). Submit the decision via record_create with a {op:'pick', group, endDate, reasoning} operation (the group may be an existing lineageId or a temp ref to a group created in the same change set). The monthly one-pager (theme + story) lives in append_plan_doc (scope monthly, ref_id = the pick id).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => resultText(prioritizeContext()),
  );

  server.registerTool(
    "weekly_plan_context",
    {
      title: "Load the weekly session context (build the week)",
      description:
        "Run when the user wants to plan their week — the ONE heavy thinking session. Read the LIVE week ahead via the user's Google Calendar MCP (read-only!). Returns the pick clock (weeks elapsed/remaining), the full group read, the chain LIBRARY (create/revise/retire/re-pick), prior v2 weekly plans, legacy weekly history, open deadline tasks, and leisure. Build the week so every day becomes cheap: chains and cues built here make daily planning selection, not creation. Echo the whole week back and get an explicit yes, then submit via create_weekly_plan (direct write — no review inbox).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => resultText(weeklyPlanContextV2()),
  );

  server.registerTool(
    "create_weekly_plan",
    {
      title: "Write the confirmed weekly plan (conversation IS the review)",
      description:
        "Direct write, all-or-nothing, only after the user's explicit yes to the echoed-back week. One call carries the whole session: chainOps (create with tempId / revise / retire / activate — the library belongs to the current pick's group), the plan fields (weekOf Monday, direction, theme, topOutcomes ≤3, milestones, health/social/maintenance priorities, fearToFace, failurePoints [{point, recovery}], successDefinition, candidateMissions, description = reported state), armedChains (1–5 lineage ids or temp:<tempId> refs), must-anchor anchoredEvents only (chains get their cue blocks at daily arm time), and ideasDone. Tell the user the week is set — this IS applied.",
      inputSchema: WeeklyPlanV2InputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async input => {
      try {
        const plan = createWeeklyPlanV2(input);
        return resultText({ status: "created", plan });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "create_weekly_plan failed");
      }
    },
  );

  server.registerTool(
    "daily_plan_context",
    {
      title: "Load the daily session context (≤5 minutes: select)",
      description:
        "Run for the daily conversation — planning tomorrow, or a morning catch-up. BUDGET: the whole session is ≤5 minutes, exchanges ~1 minute. The context returns nowLocal and planState (today + tomorrow): settle which date is being planned and, if a plan already exists for it, whether the user wants to revise it, continue living it, or leave it — their call, before anything else. Plan by SELECTION, not creation: theme one-liner plus 2–3 chains off the week's armedChains menu. Read the LIVE target date via the gcal MCP (read-only) to place cue blocks into real gaps — a block is a reminder ahead of a real-world cue, never a command. Echo the day back, get the yes, then create_daily_plan.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    },
    async ({ date }) => resultText(dailyPlanContextV2(date)),
  );

  server.registerTool(
    "create_daily_plan",
    {
      title: "Write the confirmed daily plan (conversation IS the review)",
      description:
        "Direct write, only after the user's explicit yes to the echoed-back day. Creates the plan — theme, description (reported energy/social/work state for tomorrow's planner), topPriority, supportingHealth/supportingConnection, firstDomino, minimumViableDay, parkingLot — and arms the selectedChains (≤3; chains replace the old block/todo/leisure items entirely). A selected chain with startAt/endAt gets its cue-reminder calendar block, pushed to Google Calendar when connected. ROBUSTNESS: pass a random draftKey (generated once per session) — retries with the same key return the same plan instead of erroring. If an active plan already exists for the date, the call fails unless you pass its id in revises (only after the user chose to revise): the old plan is kept as history, its UNSTARTED runs and cue blocks are cancelled, and any run with progress survives — completed work is evidence, always. Tell the user the day is set — this IS applied.",
      inputSchema: DailyPlanV2InputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async input => {
      try {
        const plan = createDailyPlanV2(input);
        return resultText({ status: "created", plan });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "create_daily_plan failed");
      }
    },
  );

  server.registerTool(
    "record_wins",
    {
      title: "Record wins to the evidence ledger",
      description:
        "Write conversational wins to the evidence ledger, only after echoing them back and getting a yes. Kinds: action, created, courage, selfcare, identity, recognition, lesson. Chain completions log themselves — record only what the user chose to tell you. Never part of a planning flow.",
      inputSchema: { entries: AddWinsSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ entries }) => {
      try {
        const rows = addWins(entries);
        return resultText({ status: "recorded", count: rows.length, wins: rows });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "record_wins failed");
      }
    },
  );

  server.registerTool(
    "current_task_context",
    {
      title: "Load the doing-mode context (help me do this task NOW)",
      description:
        "Run when the user opens with 'ugh I don't wanna do this', 'how do I do this task', or 'help me do this'. Returns the current moment: the active cue block and its chain run (steps, done-state, minimum version, reward), the next block, today's plan (theme, top priority, first domino, minimum viable day), the week's direction and fear-to-face, the month theme, and the daily/weekly/monthly one-pager docs. Coach from here: name what's actually happening, find the smallest action that changes reality (the starter step or the minimum version — it fully counts), and get them moving. Never shame, never mention what's undone beyond the mechanics of restarting.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => resultText(currentTaskContext()),
  );

  server.registerTool(
    "read_plan_doc",
    {
      title: "Read a plan's one-pager doc",
      description:
        "Read the living context doc attached to a plan: scope daily (ref_id = daily plan id), weekly (weekly plan id), or monthly (currentFocus/pick id — the monthly template lives here). Ids come from the planning contexts. Use when planning or doing needs the accumulated context ('practice triads first…').",
      inputSchema: { scope: z.enum(["daily", "weekly", "monthly"]), ref_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ scope, ref_id }) => {
      const doc = getPlanDoc(scope, ref_id);
      return resultText({ doc: doc ?? null, note: doc ? undefined : "no doc yet — append_plan_doc starts one" });
    },
  );

  server.registerTool(
    "append_plan_doc",
    {
      title: "Append to a plan's one-pager doc",
      description:
        "Grow a plan's living context doc (echo back what you're adding first). Docs accrete — the plans they annotate stay stable once made. Use for: the monthly one-pager (theme + story — scope monthly, ref_id = pick id), weekly guidance, or day-specific how-to context ('tomorrow: triads first, then that chord this way').",
      inputSchema: { scope: z.enum(["daily", "weekly", "monthly"]), ref_id: z.string().min(1), content_md: z.string().trim().min(1).max(100_000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ scope, ref_id, content_md }) => {
      try {
        const doc = appendPlanDoc(scope, ref_id, content_md);
        return resultText({ status: "appended", doc });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "append_plan_doc failed");
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
