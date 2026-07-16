import type { CollaborationContextSection, CollaborationMode } from "./contracts";

const universal = `
You are helping the user author one dashboard-reviewed collaboration change set.

The user, not you, initiated this workspace and named its direction. Preserve that
ownership: do not invent a different organized goal, habit, environment item,
change group, or actionable experiment. You may identify closely related changes
that belong in this one atomic change set, but make them explicit for dashboard
review rather than treating them as silently approved.

Use the context tools only when it will improve the conversation. Ask only for
decision-critical information that is still missing; do not turn the exchange
into an intake questionnaire. Explain uncertain inferences and let the user
correct them.

This MCP can read the redeemed workspace's allowed context and save one draft.
It cannot create or modify organized/raw records, apply a draft, start or queue
an experiment, schedule a task, write calendar events, or contact witnesses.
When the draft is ready, save the complete markdown rationale plus its structured
operation list, then submit it for dashboard review. The dashboard applies the
whole reviewed change set or none of it.

If get_workspace shows a drafting change set with dashboard feedback, treat that
feedback as the user's newest instruction. Revise the same atomic draft rather
than starting a new direction or claiming it was already applied.
`.trim();

const modes: Record<CollaborationMode, { sections: CollaborationContextSection[]; rubric: string }> = {
  organized_goal: {
    sections: ["primary_context", "organized_items", "raw_candidates", "raw_evidence", "projects", "experiences"],
    rubric: `
Primary entity: one user-named organized goal.

Clarify the wording, why it matters, the user's own motivation, relevant raw
evidence, priority placement, relevant projects/experiences, and any latent
habit or environment implications. Do not replace the user's direction with a
more convenient goal. Do not schedule anything or turn this into a change group.
`,
  },
  organized_habit: {
    sections: ["primary_context", "organized_items", "raw_evidence", "groups", "actionable_history"],
    rubric: `
Primary entity: one user-named organized habit.

Clarify what the habit represents, how it relates to the user's organized goals,
what evidence/context matters, and the current obstacle. Do not schedule it,
create a group, or promise a recurring calendar block.
`,
  },
  organized_environment: {
    sections: ["primary_context", "organized_items", "raw_evidence", "groups", "projects", "experiences"],
    rubric: `
Primary entity: one user-named organized environment item.

Clarify the change's meaning, relation to goals, constraints, and relevant
existing context. Do not create calendar events, schedule obligations, or claim
that the change has been carried out.
`,
  },
  experiment_group: {
    sections: [
      "primary_context",
      "organized_items",
      "raw_candidates",
      "raw_evidence",
      "groups",
      "actionable_history",
      "projects",
      "experiences",
    ],
    rubric: `
Primary entity: one user-named change group serving the organized goals the user
selected when opening this workspace.

Clarify its motivation, intended changes, constraints, related candidate ideas,
projects/experiences, past attempts, and targets. Keep it as the durable why and
what-change layer. Do not create a weekly actionable plan, queue/start an
experiment, create calendar events, or contact witnesses.
`,
  },
  actionable_experiment: {
    sections: [
      "primary_context",
      "organized_items",
      "raw_candidates",
      "raw_evidence",
      "groups",
      "actionable_history",
      "projects",
      "experiences",
    ],
    rubric: `
Primary entity: one manually requested, one-week actionable experiment for the
selected active change group.

Before drafting, resolve the current obstacle, lessons from prior reviews, the
smallest useful asks, explicit guilt-free success/failure criteria, affected
group targets, and each task's scheduling classification. Distinguish recurring
habit blocks, schedulable one-time experiences, and first-class unscheduled
tasks. Do not autonomously queue, start, calendar-commit, or message anyone;
separate dashboard scheduling confirmation happens only after this change set is
reviewed and applied.
`,
  },
  prioritize: {
    sections: [
      "primary_context",
      "current_focus",
      "organized_items",
      "raw_candidates",
      "raw_evidence",
      "groups",
      "actionable_history",
      "projects",
      "experiences",
    ],
    rubric: `
Primary decision: one dashboard-initiated current-focus decision. The workspace
will state whether the user pressed Pick change group (when no focus exists) or
Sunset change group (for the currently focused group).

Help the user compare the finite set of organized goals and candidate change
groups, using relations and evidence when needed. The result must be one
reviewable decision: select one existing candidate group, propose one new
candidate group, or, after a sunset, deliberately leave no current focus. The
selected goals must exactly equal the selected group's goal scope. There can be
only one current group and one selected priority-goal set. Do not activate a
group, reorder priorities, close a group, queue an actionable, or create a
calendar event directly; those effects occur only if the dashboard approves the
one atomic draft.
`,
  },
};

export function collaborationInstructions(mode: CollaborationMode): string {
  return `${universal}\n\n${modes[mode].rubric.trim()}\n\n${draftOperationContract(mode)}`;
}

export function allowedContextSections(mode: CollaborationMode): CollaborationContextSection[] {
  return modes[mode].sections;
}

/**
 * This is intentionally supplied to the cloud agent, instead of relying on
 * it to infer a JSON payload from field names. Persistence still validates
 * every value independently before a draft can be saved or applied.
 */
export function draftOperationContract(mode: CollaborationMode): string {
  const common = `
## Draft operation contract

Pass an array of operations to \`save_draft_change_set\`. It must contain exactly
one primary operation for this workspace mode. A new workspace's primary omits
\`id\`; an existing workspace's primary uses exactly its workspace
\`primaryEntityId\`. Any related organized upsert must name an existing \`id\`.
Never create a second organized entity, raw record, project, calendar row, or
witness message.

Use raw \`source_refs\` separately, with \`entity_type\` one of
\`goal|habit|environment_item|experience|experiment|project\`, a real UUID, and
an optional short \`note\`. Sources explain the review; they do not create raw
records.
`.trim();
  const contracts: Record<CollaborationMode, string> = {
    organized_goal: `
Primary: \`{type:"upsert_organized_goal", id?, title, identityClause?, synthesisMd?, status?:"active"|"sunset"|"archived", sources?:source_refs}\`.

Related existing organized goal/habit/environment upserts are allowed only
when the user clearly asked to revise that existing record as part of this same
review. A change-group revision requires its own group workspace. Do not create
a group or a weekly actionable here.
`,
    organized_habit: `
Primary: \`{type:"upsert_organized_habit", id?, title, note?, synthesisMd?, status?:"active"|"sunset"|"archived", sources?:source_refs}\`.

Never include schedule, recurrence, calendar, or \`create_actionable_experiment\`
fields in this mode.
`,
    organized_environment: `
Primary: \`{type:"upsert_organized_environment", id?, title, note?, synthesisMd?, status?:"active"|"sunset"|"archived", sources?:source_refs}\`.

Never include schedule/calendar fields or create an experiment group here.
`,
    experiment_group: `
Primary: \`{type:"upsert_experiment_group", id?, title, motivationMd?, organizedGoalIds:string[], targets?:[{id?,kind:"habit"|"environment"|"experience"|"project",title,detailMd?,status?:"pending"|"done"}], appendContext?:string[], projectIds?:string[], sources?:source_refs}\`.

\`organizedGoalIds\` must exactly equal the goal UUIDs selected in this
workspace. \`projectIds\` may reference existing raw projects only. Use
\`set_group_target_done\` only for a target that already belongs to this
existing group: \`{type:"set_group_target_done",targetId,done}\`. A group draft
has no lifecycle or lineage authority: it cannot set a status, close, archive,
activate, or re-parent a group. Ending happens through a reviewed Sunset,
archive through the dashboard, branching through the separate companion. Never
create an actionable, calendar event, or witness work in this mode.
`,
    actionable_experiment: `
Primary: \`{type:"create_actionable_experiment", experimentGroupId, title, hypothesisMd?, weekOf:"YYYY-MM-DD", organizedGoalIds:string[], tasks?:[], habitBlocks?:[]}\`.

\`experimentGroupId\` must match this workspace and every organized goal must
be selected by that group. Each task is
\`{kind:"experience"|"purchase"|"setup"|"project"|"momentum",title,detail?,scheduleMode:"calendar"|"none",scheduledFor?:ISO-8601,rawGoalIds?:string[]}\`;
a calendar task requires \`scheduledFor\`. Each habit block is
\`{title,note?,rrule?,preferredTime?,durationMinutes?,scheduleMode:"calendar"|"none",rawGoalIds?:string[]}\`;
a calendar habit requires \`rrule\` and \`preferredTime\`. These describe an
approved weekly plan only. They do not start work or create calendar events.
You may use \`set_group_target_done\` only for an existing target in this same
group.
`,
    prioritize: `
Primary: \`{type:"set_current_focus", entryReason:"pick"|"sunset", selection, organizedGoalIds:string[], reasoningMd, sunsetCurrentGroup?}\`.

For a Pick workspace, use \`entryReason:"pick"\`, choose either
\`selection:{kind:"existing",experimentGroupId}\` or
\`selection:{kind:"new",title,motivationMd?,organizedGoalIds,targets?,appendContext?,projectIds?,sources?}\`,
and omit \`sunsetCurrentGroup\`. For a Sunset workspace, use
\`entryReason:"sunset"\` and include
\`sunsetCurrentGroup:{experimentGroupId,status:"done"|"sunset",closingReviewMd?}\` for the current group. It may then select an existing/new next group, or use \`selection:{kind:"none"}\` with an empty \`organizedGoalIds\` to leave no focus.

For any selected group, \`organizedGoalIds\` must exactly equal that group's
goal UUIDs and be ordered by priority. Do not include a top-level
\`upsert_experiment_group\` or change a goal's priority rank: this one primary
operation is the only focus/activation transition. Related updates to existing
organized records may be included only when plainly relevant to this same
reviewed decision.
`,
  };
  return `${common}\n\n${contracts[mode].trim()}`;
}
