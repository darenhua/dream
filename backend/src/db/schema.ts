import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Shared column helpers — every table gets uuid id + ISO timestamps.
const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString());
const updatedAt = () =>
  text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdateFn(() => new Date().toISOString());

// Rework versioning columns (SCHEMA_AND_SURVEYS v1.1-1.3): insert-only
// content tables. lineage_id groups versions of one logical record (equal to
// the first version's id, backfilled for legacy rows); relationships point at
// lineage ids (app-level integrity — lineage ids are not unique, so no FK).
// source_conversation_id backfills when the originating thread is imported.
const versioning = () => ({
  lineageId: text("lineage_id"),
  version: integer("version"),
  prevVersionId: text("prev_version_id"),
  sourceConversationId: text("source_conversation_id"),
  description: text("description"),
});

// One row per chat thread; content_json is the reconstructed active path.
// The pipeline timestamps drive the conversation FSM:
//   awaiting_distill → awaiting_review → awaiting_derive → derived
export const conversation = sqliteTable(
  "conversation",
  {
    id: id(),
    source: text("source").notNull().default("claude"),
    externalId: text("external_id").notNull(),
    title: text("title"),
    contentJson: text("content_json"), // [{role, content, ts}] — null when parsing failed
    rawJson: text("raw_json").notNull(), // original export object, always kept
    contentHash: text("content_hash"),
    sourceCreatedAt: text("source_created_at"),
    sourceUpdatedAt: text("source_updated_at"),
    slugDetected: integer("slug_detected", { mode: "boolean" }).notNull().default(false),
    slugMessageIdx: integer("slug_message_idx"),
    // The intake gate: every imported chat is auto-classified (rant_detector),
    // candidates surface on the dashboard, and a human accept — not a slug —
    // is what admits a conversation into distill. slug columns are legacy;
    // a detected slug just auto-accepts during the transition.
    rantVerdict: text("rant_verdict", { enum: ["candidate", "not_candidate"] }), // null = not yet detected
    rantStatus: text("rant_status", { enum: ["proposed", "accepted", "rejected"] }),
    rantDetectedAt: text("rant_detected_at"),
    rantResolvedAt: text("rant_resolved_at"),
    detectorNote: text("detector_note"), // one line: why this looks like a rant
    distillRequested: integer("distill_requested", { mode: "boolean" }).notNull().default(false),
    distilledAt: text("distilled_at"),
    extractionsReviewedAt: text("extractions_reviewed_at"),
    derivedAt: text("derived_at"),
    parseError: text("parse_error"), // reason when active-path reconstruction failed
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [
    uniqueIndex("conversation_source_external").on(t.source, t.externalId),
    index("conversation_pipeline").on(
      t.slugDetected,
      t.distillRequested,
      t.distilledAt,
      t.extractionsReviewedAt,
      t.derivedAt,
    ),
  ],
);

// The immutable evidence layer: a distilled passage of the user's own words.
// Drafted by the distiller, curated by the human once, frozen forever at confirm.
export const extraction = sqliteTable(
  "extraction",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
    kind: text("kind", {
      enum: [
        "goal_talk",
        "habit_talk",
        "environment_talk",
        "experience_talk",
        "project_talk",
        "experiment_idea",
        "feeling",
      ],
    }).notNull(),
    text: text("text").notNull(), // user-editable pre-confirm only
    startIdx: integer("start_idx"), // span into content_json; null for manual adds
    endIdx: integer("end_idx"),
    contentHash: text("content_hash").notNull(), // conversation hash at distill time (pin-staleness key)
    origin: text("origin", { enum: ["agent", "manual"] }).notNull(),
    agentRunId: text("agent_run_id").references(() => agentRun.id),
    confirmedAt: text("confirmed_at"), // frozen forever once set
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [index("extraction_conversation").on(t.conversationId), index("extraction_confirmed").on(t.confirmedAt)],
);

// Permanent provenance: which extraction fed which entity, and via which
// ratification. Polymorphic on purpose — entities are never hard-deleted, and
// both directions ("evidence behind X", "what did this extraction feed") need
// one query shape. entityType values are zod-checked in the service layer.
export const extractionLink = sqliteTable(
  "extraction_link",
  {
    id: id(),
    extractionId: text("extraction_id")
      .notNull()
      .references(() => extraction.id),
    entityType: text("entity_type").notNull(), // goal|habit|environment_item|experience|experiment|experiment_task
    entityId: text("entity_id").notNull(),
    proposalId: text("proposal_id").references(() => proposal.id),
    createdAt: createdAt(),
  },
  t => [
    uniqueIndex("extraction_link_unique").on(t.extractionId, t.entityType, t.entityId),
    index("extraction_link_entity").on(t.entityType, t.entityId),
  ],
);

export const goal = sqliteTable("goal", {
  id: id(),
  title: text("title").notNull(),
  identityClause: text("identity_clause"),
  synthesisMd: text("synthesis_md"),
  // succeeded = the self actually changed; irrelevant = retired without shame.
  status: text("status", { enum: ["active", "backlog", "dormant", "succeeded", "irrelevant"] })
    .notNull()
    .default("backlog"),
  sortOrder: integer("sort_order").notNull().default(0),
  origin: text("origin", { enum: ["derived", "manual"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const goalEvidence = sqliteTable("goal_evidence", {
  id: id(),
  goalId: text("goal_id")
    .notNull()
    .references(() => goal.id),
  conversationId: text("conversation_id").references(() => conversation.id),
  note: text("note"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// established = part of the current self (derive maps these);
// building = being attempted inside a running experiment;
// lapsed = not currently held — statuses only, nothing deleted.
export const habit = sqliteTable("habit", {
  id: id(),
  ...versioning(),
  currentFocusId: text("current_focus_id"), // system habits: which pick birthed it
  title: text("title").notNull(),
  note: text("note"),
  valence: text("valence", { enum: ["good", "bad"] }).notNull().default("good"),
  status: text("status", { enum: ["established", "building", "lapsed"] }).notNull(),
  rrule: text("rrule"), // RFC5545 RRULE string for the recurring calendar block
  preferredTime: text("preferred_time"), // "HH:MM" local
  durationMinutes: integer("duration_minutes"),
  experimentId: text("experiment_id").references(() => experiment.id), // set when born inside an experiment
  origin: text("origin", { enum: ["derived", "manual", "experiment"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// physical_setup never schedules; obligations carry recurrence (service-enforced).
export const environmentItem = sqliteTable("environment_item", {
  id: id(),
  ...versioning(),
  habitLineageId: text("habit_lineage_id"), // required (app-level) for conversation origin
  effect: text("effect", { enum: ["easier", "harder"] }),
  title: text("title").notNull(),
  note: text("note"),
  subKind: text("sub_kind", { enum: ["physical_setup", "obligation", "social"] }).notNull(),
  status: text("status", { enum: ["active", "removed"] }).notNull().default("active"),
  rrule: text("rrule"),
  durationMinutes: integer("duration_minutes"),
  origin: text("origin", { enum: ["derived", "manual"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Append-only: experiences are never pruned anywhere in the domain.
export const experience = sqliteTable("experience", {
  id: id(),
  title: text("title").notNull(),
  note: text("note"),
  state: text("state", { enum: ["planned", "had"] }).notNull(),
  plannedFor: text("planned_for"), // ISO datetime of the one-time calendar event
  hadAt: text("had_at"),
  experimentTaskId: text("experiment_task_id").references(() => experimentTask.id),
  origin: text("origin", { enum: ["derived", "manual", "experiment"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Projects are intentionally a lightweight raw registry for now. They are
// proposal-derived context that can serve an organized goal/group or an
// actionable experiment, without prematurely becoming a project-management
// system.
export const project = sqliteTable("project", {
  id: id(),
  ...versioning(),
  title: text("title").notNull(),
  note: text("note"),
  origin: text("origin", { enum: ["derived", "manual"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// The organized layer is deliberately separate from proposal-derived rows.
// It is user-initiated through a collaboration change set; raw rows remain
// evidence and agent-readable material rather than being overwritten.
export const organizedGoal = sqliteTable("organized_goal", {
  id: id(),
  ...versioning(),
  retiredAt: text("retired_at"),
  title: text("title").notNull(),
  identityClause: text("identity_clause"),
  synthesisMd: text("synthesis_md"),
  // A null rank means "out of priority". Non-null ranks form the user's
  // drag-and-drop priority list; this is intentionally not a top-three cap.
  priorityRank: integer("priority_rank"),
  status: text("status", { enum: ["active", "sunset", "archived"] }).notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizedGoalSource = sqliteTable(
  "organized_goal_source",
  {
    id: id(),
    organizedGoalId: text("organized_goal_id")
      .notNull()
      .references(() => organizedGoal.id),
    // Polymorphic raw reference: goal|habit|environment_item|experience|
    // experiment|project. It gives the missing organized → raw provenance hop.
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: createdAt(),
  },
  t => [
    uniqueIndex("organized_goal_source_unique").on(t.organizedGoalId, t.entityType, t.entityId),
    index("organized_goal_source_entity").on(t.entityType, t.entityId),
  ],
);

export const organizedHabit = sqliteTable("organized_habit", {
  id: id(),
  title: text("title").notNull(),
  note: text("note"),
  synthesisMd: text("synthesis_md"),
  status: text("status", { enum: ["active", "sunset", "archived"] }).notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizedEnvironmentItem = sqliteTable("organized_environment_item", {
  id: id(),
  title: text("title").notNull(),
  note: text("note"),
  synthesisMd: text("synthesis_md"),
  status: text("status", { enum: ["active", "sunset", "archived"] }).notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizedRegistrySource = sqliteTable(
  "organized_registry_source",
  {
    id: id(),
    organizedEntityType: text("organized_entity_type", { enum: ["habit", "environment"] }).notNull(),
    organizedEntityId: text("organized_entity_id").notNull(),
    rawEntityType: text("raw_entity_type").notNull(),
    rawEntityId: text("raw_entity_id").notNull(),
    createdAt: createdAt(),
  },
  t => [
    uniqueIndex("organized_registry_source_unique").on(
      t.organizedEntityType,
      t.organizedEntityId,
      t.rawEntityType,
      t.rawEntityId,
    ),
    index("organized_registry_source_raw").on(t.rawEntityType, t.rawEntityId),
  ],
);

export const projectSource = sqliteTable(
  "project_source",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: createdAt(),
  },
  t => [
    uniqueIndex("project_source_unique").on(t.projectId, t.entityType, t.entityId),
    index("project_source_entity").on(t.entityType, t.entityId),
  ],
);

// A group is the long-lived user-approved "change". It intentionally has no
// calendar or witness linkage: only a child actionable experiment can reach
// those execution systems.
export const experimentGroup = sqliteTable("experiment_group", {
  id: id(),
  ...versioning(),
  theme: text("theme"),
  title: text("title").notNull(),
  motivationMd: text("motivation_md"),
  // A branch is a new, independently selectable change story. The parent is
  // retained as context even when it is later archived from the working view.
  parentExperimentGroupId: text("parent_experiment_group_id").references((): AnySQLiteColumn => experimentGroup.id),
  status: text("status", { enum: ["candidate", "active", "done", "sunset", "archived"] })
    .notNull()
    .default("candidate"),
  closingReviewMd: text("closing_review_md"),
  // Archiving is reversible, but never restores an active state. Keeping the
  // prior terminal/candidate state makes the history explicit without hiding
  // or deleting a parent that has branches.
  archivedAt: text("archived_at"),
  archivedFromStatus: text("archived_from_status", { enum: ["candidate", "done", "sunset"] }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [index("experiment_group_parent").on(t.parentExperimentGroupId)]);

// Current focus is a durable decision/history record, not a dashboard filter.
// A partial unique index permits at most one current row across the whole
// personal workspace. Its selected goals live in the ordered child table.
export const currentFocus = sqliteTable(
  "current_focus",
  {
    id: id(),
    experimentGroupId: text("experiment_group_id")
      .notNull()
      .references(() => experimentGroup.id),
    previousCurrentFocusId: text("previous_current_focus_id"),
    status: text("status", { enum: ["current", "ended", "superseded"] }).notNull().default("current"),
    entryReason: text("entry_reason", { enum: ["pick", "sunset"] }).notNull(),
    endDate: text("end_date"), // pick deadline (YYYY-MM-DD); expiry re-arms prioritize
    reasoningMd: text("reasoning_md").notNull(),
    // Kept as a logical ID rather than an FK because draft_change_set is
    // declared later in this schema module.
    sourceChangeSetId: text("source_change_set_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    createdAt: createdAt(),
  },
  t => [
    index("current_focus_group").on(t.experimentGroupId),
    uniqueIndex("current_focus_one_current").on(t.status).where(sql`${t.status} = 'current'`),
  ],
);

export const currentFocusGoal = sqliteTable(
  "current_focus_goal",
  {
    id: id(),
    currentFocusId: text("current_focus_id")
      .notNull()
      .references(() => currentFocus.id),
    organizedGoalId: text("organized_goal_id")
      .notNull()
      .references(() => organizedGoal.id),
    priorityRank: integer("priority_rank").notNull(),
    createdAt: createdAt(),
  },
  t => [
    uniqueIndex("current_focus_goal_unique").on(t.currentFocusId, t.organizedGoalId),
    uniqueIndex("current_focus_goal_rank_unique").on(t.currentFocusId, t.priorityRank),
  ],
);

export const experimentGroupGoal = sqliteTable(
  "experiment_group_goal",
  {
    id: id(),
    experimentGroupId: text("experiment_group_id")
      .notNull()
      .references(() => experimentGroup.id),
    organizedGoalId: text("organized_goal_id")
      .notNull()
      .references(() => organizedGoal.id),
    rank: integer("rank"), // rework: curated priority order of the group's goal set
    createdAt: createdAt(),
  },
  t => [uniqueIndex("experiment_group_goal_unique").on(t.experimentGroupId, t.organizedGoalId)],
);

export const experimentGroupTarget = sqliteTable("experiment_group_target", {
  id: id(),
  experimentGroupId: text("experiment_group_id")
    .notNull()
    .references(() => experimentGroup.id),
  kind: text("kind", { enum: ["habit", "environment", "experience", "project"] }).notNull(),
  title: text("title").notNull(),
  detailMd: text("detail_md"),
  status: text("status", { enum: ["pending", "done"] }).notNull().default("pending"),
  doneAt: text("done_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const experimentGroupContext = sqliteTable("experiment_group_context", {
  id: id(),
  experimentGroupId: text("experiment_group_id")
    .notNull()
    .references(() => experimentGroup.id),
  textMd: text("text_md").notNull(),
  sourceChangeSetId: text("source_change_set_id"),
  createdAt: createdAt(),
});

export const experimentGroupProject = sqliteTable(
  "experiment_group_project",
  {
    id: id(),
    experimentGroupId: text("experiment_group_id")
      .notNull()
      .references(() => experimentGroup.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("experiment_group_project_unique").on(t.experimentGroupId, t.projectId)],
);

export const experimentGroupSource = sqliteTable(
  "experiment_group_source",
  {
    id: id(),
    experimentGroupId: text("experiment_group_id")
      .notNull()
      .references(() => experimentGroup.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: createdAt(),
  },
  t => [
    uniqueIndex("experiment_group_source_unique").on(t.experimentGroupId, t.entityType, t.entityId),
    index("experiment_group_source_entity").on(t.entityType, t.entityId),
  ],
);

// A goal's persistent ideal sets — which habits/environment constitute it.
export const goalHabit = sqliteTable(
  "goal_habit",
  {
    id: id(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goal.id),
    habitId: text("habit_id")
      .notNull()
      .references(() => habit.id),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("goal_habit_unique").on(t.goalId, t.habitId)],
);

export const goalEnvironment = sqliteTable(
  "goal_environment",
  {
    id: id(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goal.id),
    environmentItemId: text("environment_item_id")
      .notNull()
      .references(() => environmentItem.id),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("goal_environment_unique").on(t.goalId, t.environmentItemId)],
);

// queued → scheduling → running → succeeded | failed. Blame-free by design:
// failing is one call with optional improvement notes for the next attempt.
export const experiment = sqliteTable("experiment", {
  id: id(),
  title: text("title").notNull(),
  hypothesisMd: text("hypothesis_md"),
  // Candidate = raw proposal-derived learning material. Actionable = a
  // user-approved weekly child of an experiment group and the only kind that
  // can enter scheduling/calendar/witness flows.
  kind: text("kind", { enum: ["candidate", "actionable"] }).notNull().default("candidate"),
  experimentGroupId: text("experiment_group_id").references(() => experimentGroup.id),
  // Rework: a weekly plan belongs to a specific pick, not just a group.
  currentFocusId: text("current_focus_id"),
  theme: text("theme"),
  description: text("description"),
  weekOf: text("week_of"), // local Monday YYYY-MM-DD for an actionable week
  status: text("status", {
    enum: ["queued", "scheduling", "running", "succeeded", "failed", "archived"],
  })
    .notNull()
    .default("queued"),
  proposalId: text("proposal_id").references(() => proposal.id),
  bandwidth: text("bandwidth"), // free text captured during the scheduling chat
  plannedDurationDays: integer("planned_duration_days"), // stored, never enforced
  proposedChangesJson: text("proposed_changes_json"), // the derived checklist (from experiment_propose)
  planJson: text("plan_json"), // the committed SchedulePlan artifact
  queuedAt: text("queued_at"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  outcomeMd: text("outcome_md"), // self-reported notes at end
  reviewMd: text("review_md"), // why the actionable succeeded/failed; next week reads it
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Which goals an experiment tackles; ended experiments per goal = the attempt heatmap.
export const experimentGoal = sqliteTable(
  "experiment_goal",
  {
    id: id(),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => experiment.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goal.id),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("experiment_goal_unique").on(t.experimentId, t.goalId)],
);

// Product-semantic goal links. The legacy experiment_goal table remains the
// raw-goal/witness bridge; this table records which organized goals a weekly
// actionable or group-directed change actually serves.
export const experimentOrganizedGoal = sqliteTable(
  "experiment_organized_goal",
  {
    id: id(),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => experiment.id),
    organizedGoalId: text("organized_goal_id")
      .notNull()
      .references(() => organizedGoal.id),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("experiment_organized_goal_unique").on(t.experimentId, t.organizedGoalId)],
);

// One-off deliverables of an experiment (experiences to have, things to buy,
// environment setup); recurring habit blocks live on the habit rows instead.
export const experimentTask = sqliteTable("experiment_task", {
  id: id(),
  experimentId: text("experiment_id")
    .notNull()
    .references(() => experiment.id),
  kind: text("kind", { enum: ["experience", "purchase", "setup", "project", "momentum"] }).notNull(),
  title: text("title").notNull(),
  detail: text("detail"),
  status: text("status", { enum: ["pending", "scheduled", "done", "skipped"] })
    .notNull()
    .default("pending"),
  // Calendar is opt-in task by task. "none" remains a first-class dashboard
  // task and must never be silently sent to Google Calendar.
  scheduleMode: text("schedule_mode", { enum: ["calendar", "none"] }).notNull().default("calendar"),
  scheduledFor: text("scheduled_for"),
  doneAt: text("done_at"), // rework: weekly-plan item completion
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Which goals a specific task addresses — sub-experiment granularity for
// witness scoping. A task with no rows here is invisible to every witness
// (fail closed); commitPlan defaults untagged tasks to the experiment's goals.
export const experimentTaskGoal = sqliteTable(
  "experiment_task_goal",
  {
    id: id(),
    experimentTaskId: text("experiment_task_id")
      .notNull()
      .references(() => experimentTask.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goal.id),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("experiment_task_goal_unique").on(t.experimentTaskId, t.goalId)],
);

// The witness registry: accountability friends. The seat is the feature, the
// occupant is replaceable. chatId binds the friend's chat once a transport
// links it; until then the manual copy-paste protocol carries everything.
export const witness = sqliteTable("witness", {
  id: id(),
  name: text("name").notNull(),
  platform: text("platform", { enum: ["manual", "imessage", "telegram"] })
    .notNull()
    .default("manual"),
  handle: text("handle"), // phone/email on the platform
  timezone: text("timezone").notNull().default("America/New_York"),
  status: text("status", { enum: ["invited", "active", "paused", "removed"] })
    .notNull()
    .default("invited"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false), // ≤1 enforced in service
  inviteCode: text("invite_code").unique(), // one-time chat-link code (JOIN fallback)
  // The Messages.app chat this witness lives in. Null until the user picks an
  // existing group from the daemon's published list — the local kit cannot
  // create groups, and these ids encode Messages internals so are never built.
  chatId: text("chat_id"),
  linkedAt: text("linked_at"),
  promptCadenceDays: integer("prompt_cadence_days").notNull().default(4), // friend-tunable (less/more)
  lastPromptAt: text("last_prompt_at"),
  mutedUntil: text("muted_until"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Goal-scoped visibility: a witness sees ONLY content reachable from these
// goals. Enforced at the query layer (witnessScope.ts), not the prompt layer.
export const witnessGoal = sqliteTable(
  "witness_goal",
  {
    id: id(),
    witnessId: text("witness_id")
      .notNull()
      .references(() => witness.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goal.id),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("witness_goal_unique").on(t.witnessId, t.goalId)],
);

// The in-dashboard agent conversations: scheduling, review interviews,
// experiment shaping, and "steer" — the universal EDIT next to accept/deny.
// A steer session anchors to the generation it revises via targetType/targetId
// ("distill" → conversation, "proposal" → pending proposal, "goal" → goal);
// finishing re-runs that generation with the chat as steering hints and
// REPLACES the artifact in place — never a duplicate.
export const chatSession = sqliteTable("chat_session", {
  id: id(),
  purpose: text("purpose", { enum: ["schedule", "review_interview", "experiment_shaping", "steer"] })
    .notNull()
    .default("schedule"),
  experimentId: text("experiment_id").references(() => experiment.id),
  targetType: text("target_type", { enum: ["distill", "proposal", "goal"] }),
  targetId: text("target_id"),
  status: text("status", { enum: ["open", "committed", "cancelled"] }).notNull().default("open"),
  planJson: text("plan_json"), // latest structured plan draft the chat converges on
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const chatMessage = sqliteTable(
  "chat_message",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSession.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    agentRunId: text("agent_run_id").references(() => agentRun.id),
    createdAt: createdAt(),
  },
  t => [index("chat_message_session").on(t.sessionId)],
);

// A dashboard-created code grants a cloud MCP conversation access to one
// narrowly scoped drafting workspace. The secret itself is never persisted.
export const collaborationInvite = sqliteTable(
  "collaboration_invite",
  {
    id: id(),
    mode: text("mode", {
      enum: [
        "organized_goal",
        "organized_habit",
        "organized_environment",
        "experiment_group",
        "actionable_experiment",
        "prioritize",
      ],
    }).notNull(),
    primaryEntityType: text("primary_entity_type"),
    primaryEntityId: text("primary_entity_id"),
    experimentGroupId: text("experiment_group_id").references(() => experimentGroup.id),
    prioritizeAction: text("prioritize_action", { enum: ["pick", "sunset"] }),
    // Seed/goal selections are chosen in the dashboard before the user hands
    // the one-time code to MCP; redemption copies them into the workspace.
    userSeedMd: text("user_seed_md"),
    selectedOrganizedGoalIdsJson: text("selected_organized_goal_ids_json"),
    secretHash: text("secret_hash").notNull().unique(),
    // Separate dashboard capability. The OTP binds an MCP connection; this
    // value authorizes the dashboard's later read/review/apply operations.
    // It stays nullable only so installations that briefly ran an earlier
    // pre-release migration can upgrade safely; new invites always set it.
    dashboardSecretHash: text("dashboard_secret_hash").unique(),
    expiresAt: text("expires_at").notNull(),
    redeemedAt: text("redeemed_at"),
    workspaceId: text("workspace_id"),
    createdAt: createdAt(),
  },
  t => [index("collaboration_invite_expiry").on(t.expiresAt)],
);

export const collaborationWorkspace = sqliteTable(
  "collaboration_workspace",
  {
    id: id(),
    inviteId: text("invite_id")
      .notNull()
      .unique()
      .references(() => collaborationInvite.id),
    mode: text("mode", {
      enum: [
        "organized_goal",
        "organized_habit",
        "organized_environment",
        "experiment_group",
        "actionable_experiment",
        "prioritize",
      ],
    }).notNull(),
    status: text("status", { enum: ["open", "draft_ready", "applied", "rejected", "expired"] })
      .notNull()
      .default("open"),
    primaryEntityType: text("primary_entity_type").notNull(),
    primaryEntityId: text("primary_entity_id"),
    experimentGroupId: text("experiment_group_id").references(() => experimentGroup.id),
    prioritizeAction: text("prioritize_action", { enum: ["pick", "sunset"] }),
    userSeedMd: text("user_seed_md"),
    selectedOrganizedGoalIdsJson: text("selected_organized_goal_ids_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [index("collaboration_workspace_status").on(t.status)],
);

// A code-linked, immutable orientation artifact for a creator workspace. It
// gives a blank cloud agent a bounded map of accepted/raw material and the
// related organized layer without turning relevance heuristics into writes.
// It is persisted rather than held in a deploy-local file so a redeemed code
// remains reproducible across process restarts.
export const collaborationWorkspaceIndex = sqliteTable(
  "collaboration_workspace_index",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .unique()
      .references(() => collaborationWorkspace.id),
    indexVersion: integer("index_version").notNull().default(1),
    markdownIndex: text("markdown_index").notNull(),
    referenceManifestJson: text("reference_manifest_json").notNull(),
    sourceSnapshotJson: text("source_snapshot_json").notNull(),
    generatedAt: text("generated_at").notNull(),
    createdAt: createdAt(),
  },
  t => [index("collaboration_workspace_index_workspace").on(t.workspaceId)],
);

// MCP can create and revise only this record. Applying it is a separate,
// dashboard-only transactional service operation.
export const draftChangeSet = sqliteTable(
  "draft_change_set",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => collaborationWorkspace.id),
    mode: text("mode", {
      enum: [
        "organized_goal",
        "organized_habit",
        "organized_environment",
        "experiment_group",
        "actionable_experiment",
        "prioritize",
      ],
    }).notNull(),
    primaryEntityType: text("primary_entity_type").notNull(),
    primaryEntityId: text("primary_entity_id"),
    summaryMd: text("summary_md").notNull(),
    operationsJson: text("operations_json").notNull(),
    sourceRefsJson: text("source_refs_json"),
    auditJson: text("audit_json"),
    status: text("status", { enum: ["drafting", "ready_for_review", "applied", "rejected", "expired"] })
      .notNull()
      .default("drafting"),
    rejectionNote: text("rejection_note"),
    // Rework: AI reconciliation verdicts per row (new | version-bump-of |
    // remix-of | link-to-existing) and the marker token for import stitching.
    reconciliationJson: text("reconciliation_json"),
    markerToken: text("marker_token"),
    submittedAt: text("submitted_at"),
    appliedAt: text("applied_at"),
    rejectedAt: text("rejected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [index("draft_change_set_workspace").on(t.workspaceId), index("draft_change_set_status").on(t.status)],
);

// The persistent no-code companion's quarantined inbox. A companion
// conversation can only ever write here: one explicitly requested branch
// draft per submission, owned by an authenticated companion identity. No
// domain row exists until the dashboard reviews and applies the whole draft.
export const companionBranchDraft = sqliteTable(
  "companion_branch_draft",
  {
    id: id(),
    // Ownership key, not merely audit text: every read/apply/reject filters
    // on it so one companion identity can never see another's drafts.
    companionIdentityId: text("companion_identity_id").notNull(),
    parentExperimentGroupId: text("parent_experiment_group_id")
      .notNull()
      .references(() => experimentGroup.id),
    userSeedMd: text("user_seed_md").notNull(),
    summaryMd: text("summary_md").notNull(),
    operationsJson: text("operations_json").notNull(),
    sourceRefsJson: text("source_refs_json"),
    auditJson: text("audit_json"),
    status: text("status", { enum: ["drafting", "ready_for_review", "applied", "rejected", "expired"] })
      .notNull()
      .default("drafting"),
    rejectionNote: text("rejection_note"),
    appliedAt: text("applied_at"),
    rejectedAt: text("rejected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [
    index("companion_branch_draft_identity").on(t.companionIdentityId),
    index("companion_branch_draft_status").on(t.status),
    index("companion_branch_draft_parent").on(t.parentExperimentGroupId),
  ],
);

// Local ↔ Google Calendar mapping for everything on the dream calendar.
// blockStyle drives the GCal colorId (experiment blocks visually distinct).
export const calendarEvent = sqliteTable(
  "calendar_event",
  {
    id: id(),
    entityType: text("entity_type").notNull(), // habit|environment_item|experience|experiment_task
    entityId: text("entity_id").notNull(),
    gcalEventId: text("gcal_event_id").unique(), // null until pushed
    title: text("title").notNull(),
    startAt: text("start_at").notNull(), // first-instance times for recurring events
    endAt: text("end_at").notNull(),
    rrule: text("rrule"),
    blockStyle: text("block_style", { enum: ["habit", "experiment", "obligation", "task"] }).notNull(),
    status: text("status", { enum: ["active", "cancelled", "needs_reschedule"] })
      .notNull()
      .default("active"),
    lastSyncedAt: text("last_synced_at"),
    // Rework: explicit push bookkeeping ("was the calendar job done") and
    // completion tracking; GCal is the source of truth for event state.
    pushedAt: text("pushed_at"),
    pushFailedAt: text("push_failed_at"),
    pushError: text("push_error"),
    completedAt: text("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [index("calendar_event_entity").on(t.entityType, t.entityId)],
);

// One-tap check-ins. A day's anchors override the configured sleep/work
// defaults for free-time computation, and double as the lightweight
// habit-tracking signal (stored now, surfaced later).
export const anchorEvent = sqliteTable(
  "anchor_event",
  {
    id: id(),
    kind: text("kind", { enum: ["wake_up", "start_work", "end_work", "sleep"] }).notNull(),
    date: text("date").notNull(), // YYYY-MM-DD local — the day it overrides
    at: text("at").notNull(), // ISO datetime of the tap
    createdAt: createdAt(),
  },
  t => [index("anchor_event_date").on(t.date)],
);

// Dedicated table, NOT config: GET /api/config is dashboard-visible and
// OAuth tokens must never leak there.
export const googleAuth = sqliteTable("google_auth", {
  id: text("id").primaryKey().default("singleton"),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  accessTokenExpiresAt: text("access_token_expires_at"),
  dreamCalendarId: text("dream_calendar_id"),
  syncToken: text("sync_token"),
  updatedAt: updatedAt(),
});

// The single ratification gate. scope_key is always conversation:{id} now;
// superseded survives only for manual re-derive of a conversation.
export const proposal = sqliteTable(
  "proposal",
  {
    id: id(),
    // ADD + UPDATE only: removals and goal-status changes are manual CRUD.
    // The one derived status change lives inside habit_update (lapsed ⇄ established).
    kind: text("kind", {
      enum: [
        "goal_create",
        "goal_update",
        "synthesis_update",
        "habit_add",
        "habit_update",
        "environment_add",
        "environment_update",
        "experience_add",
        "project_add",
        "experiment_propose",
      ],
    }).notNull(),
    payloadJson: text("payload_json").notNull(), // self-contained mutation incl. extraction_ids
    scopeKey: text("scope_key").notNull(),
    agentRunId: text("agent_run_id").references(() => agentRun.id),
    status: text("status", { enum: ["pending", "approved", "denied", "superseded"] })
      .notNull()
      .default("pending"),
    resolvedAt: text("resolved_at"),
    denialNote: text("denial_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [index("proposal_scope_status").on(t.scopeKey, t.status)],
);

export const agentRun = sqliteTable("agent_run", {
  id: id(),
  agentName: text("agent_name", {
    enum: [
      "distiller",
      "deriver",
      "proposal_reviser",
      "proposal_enricher",
      "schedule_agent",
      "prompt_generator",
      "daily_writeup",
      "rant_detector",
      "review_writeup",
      "witness_composer",
      "witness_prompter",
      "goal_editor",
    ],
  }).notNull(),
  trigger: text("trigger", { enum: ["daily", "manual"] }).notNull(),
  workspacePath: text("workspace_path"),
  outputJson: text("output_json"),
  status: text("status", { enum: ["ok", "invalid_output", "failed"] }).notNull(),
  tokenUsage: text("token_usage"), // json {input, output}
  durationMs: integer("duration_ms"),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Append-only trajectory.
export const event = sqliteTable(
  "event",
  {
    id: id(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json"),
    createdAt: createdAt(),
  },
  t => [index("event_entity").on(t.entityType, t.entityId)],
);

// Typed key-value; values stored as JSON strings.
export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});

// The review artifact endExperiment lacked: agent-drafted from the run's
// evidence, human-edited, frozen at approve — approval fans out per-witness
// goal-filtered shares into the outbox.
export const reviewWriteup = sqliteTable("review_writeup", {
  id: id(),
  experimentId: text("experiment_id")
    .notNull()
    .unique()
    .references(() => experiment.id),
  draftMd: text("draft_md"),
  finalMd: text("final_md"), // user-edited, frozen at approve
  status: text("status", { enum: ["drafting", "draft_ready", "approved"] })
    .notNull()
    .default("drafting"),
  agentRunId: text("agent_run_id").references(() => agentRun.id),
  approvedAt: text("approved_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// The approval gate + durable queue: NOTHING reaches a transport without
// status=approved. Every agent-composed message lands here as
// pending_approval; the user reads/edits/copies before anything moves.
export const outboundMessage = sqliteTable(
  "outbound_message",
  {
    id: id(),
    witnessId: text("witness_id")
      .notNull()
      .references(() => witness.id),
    kind: text("kind", {
      enum: ["welcome", "review_share", "experiment_announcement", "random_prompt", "strike_alert", "duty_ping"],
    }).notNull(),
    bodyText: text("body_text").notNull(), // user-editable pre-send
    // What the composer originally wrote, frozen at enqueue. bodyText is
    // overwritten by edits; this is the signal for "is the agent's voice good
    // enough to trust with autosend" — never write to it after insert.
    originalBodyText: text("original_body_text"),
    contextJson: text("context_json"), // e.g. suggested follow-up questions
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    dedupeKey: text("dedupe_key"), // one ping per staleness episode
    status: text("status", { enum: ["pending_approval", "approved", "sent", "failed", "cancelled"] })
      .notNull()
      .default("pending_approval"),
    notBefore: text("not_before"), // quiet-hours / spacing gate
    // The row is the log: createdAt = enqueued, approvedAt = gate passed,
    // sentAt = on the wire. updatedAt is clobbered by later writes, so the
    // lifecycle needs its own stamps to be reconstructable from the row alone.
    approvedAt: text("approved_at"),
    sentAt: text("sent_at"),
    transportMessageId: text("transport_message_id"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [index("outbound_status").on(t.status), index("outbound_dedupe").on(t.dedupeKey)],
);

// Raw inbound firehose from the messenger daemon. witnessId is resolved at
// ingest when the chat is linked; unlinked chats keep null (JOIN handshake,
// strangers). transportMessageId dedupes redeliveries after reconnects.
export const inboundMessage = sqliteTable(
  "inbound_message",
  {
    id: id(),
    witnessId: text("witness_id").references(() => witness.id),
    chatId: text("chat_id").notNull(),
    senderHandle: text("sender_handle").notNull(),
    fromUser: integer("from_user", { mode: "boolean" }).notNull().default(false),
    text: text("text").notNull(),
    transportMessageId: text("transport_message_id").unique(),
    processedAt: text("processed_at"),
    createdAt: createdAt(),
  },
  t => [index("inbound_chat").on(t.chatId)],
);

// Strike bookkeeping ONLY — the counts themselves are always computed live
// from existing tables (strikes.ts), never stored. This singleton holds the
// two things that aren't derivable: pause mode and one-alert-per-episode.
export const strikeState = sqliteTable("strike_state", {
  id: text("id").primaryKey().default("singleton"),
  pausedUntil: text("paused_until"), // YYYY-MM-DD; "pause 10d — traveling"
  pauseReason: text("pause_reason"),
  armed: integer("armed", { mode: "boolean" }).notNull().default(true), // re-arms when total < threshold
  lastAlertAt: text("last_alert_at"),
  updatedAt: updatedAt(),
});

// Kept but demoted: the daily glance bait, not the trajectory mechanism.
export const dailyWriteup = sqliteTable("daily_writeup", {
  id: id(),
  date: text("date").notNull().unique(), // YYYY-MM-DD
  text: text("text").notNull(),
  agentRunId: text("agent_run_id").references(() => agentRun.id),
  daysSinceLastVisitAtGeneration: integer("days_since_last_visit_at_generation"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Rework tables (SCHEMA_AND_SURVEYS v1.1-1.3) ─────────────────────────────
// Relationship tables store lineage references as plain text: lineage ids are
// shared across versions so they cannot carry DB-level FKs; integrity lives in
// the change-set apply path.

// Remix/branch parentage. One row per parent; multiple rows = a combine.
export const lineageParent = sqliteTable(
  "lineage_parent",
  {
    id: id(),
    childType: text("child_type").notNull(),
    childLineageId: text("child_lineage_id").notNull(),
    parentType: text("parent_type").notNull(),
    parentVersionId: text("parent_version_id").notNull(),
    createdAt: createdAt(),
  },
  t => [index("lineage_parent_child").on(t.childType, t.childLineageId)],
);

// The provenance spine: which conversation slice created/mentioned which
// record version. Rows are written at import time, matched by marker token.
export const conversationRecordLink = sqliteTable(
  "conversation_record_link",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
    markerToken: text("marker_token").notNull(),
    sliceEndIdx: integer("slice_end_idx"),
    recordType: text("record_type").notNull(),
    recordVersionId: text("record_version_id").notNull(),
    role: text("role", { enum: ["created_central", "created_satellite", "mentioned"] }).notNull(),
    createdAt: createdAt(),
  },
  t => [
    index("conversation_record_link_conversation").on(t.conversationId),
    index("conversation_record_link_record").on(t.recordType, t.recordVersionId),
  ],
);

// A fact about how current-me feels and reacts (trigger → emotion → coping →
// feedback loop, all in one description). Read by the rant-style read_record
// conversations, never by planners.
export const patternOfBehavior = sqliteTable("pattern_of_behavior", {
  id: id(),
  ...versioning(),
  title: text("title").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// "Pointer on goal": which patterns explain/affect a goal.
export const goalPattern = sqliteTable(
  "goal_pattern",
  {
    id: id(),
    goalLineageId: text("goal_lineage_id").notNull(),
    patternLineageId: text("pattern_lineage_id").notNull(),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("goal_pattern_unique").on(t.goalLineageId, t.patternLineageId)],
);

// The volatile ambition record — can be a one-liner. Not yet real by
// definition; reality begins at pick time (habit materialization).
export const experimentIdea = sqliteTable("experiment_idea", {
  id: id(),
  ...versioning(),
  title: text("title").notNull(),
  retiredAt: text("retired_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// THE why-bearing relationship: why doing this idea serves that goal, in the
// user's words (description). Groups and planners read these.
export const ideaGoal = sqliteTable(
  "idea_goal",
  {
    id: id(),
    ideaLineageId: text("idea_lineage_id").notNull(),
    goalLineageId: text("goal_lineage_id").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("idea_goal_unique").on(t.ideaLineageId, t.goalLineageId)],
);

export const ideaProject = sqliteTable(
  "idea_project",
  {
    id: id(),
    ideaLineageId: text("idea_lineage_id").notNull(),
    projectLineageId: text("project_lineage_id").notNull(),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("idea_project_unique").on(t.ideaLineageId, t.projectLineageId)],
);

// One-off responsibility. An attached experiment idea (≤1) is what makes a
// task goal-minded; without one it is a plain errand.
export const task = sqliteTable("task", {
  id: id(),
  ...versioning(),
  title: text("title").notNull(),
  deadlineDate: text("deadline_date"), // YYYY-MM-DD; drives planner nagging
  doneAt: text("done_at"),
  droppedAt: text("dropped_at"),
  experimentIdeaLineageId: text("experiment_idea_lineage_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Group membership: which ideas a campaign adopted, and per-campaign
// done-state. Separate from the idea's permanent goal links.
export const groupIdea = sqliteTable(
  "group_idea",
  {
    id: id(),
    groupLineageId: text("group_lineage_id").notNull(),
    ideaLineageId: text("idea_lineage_id").notNull(),
    doneAt: text("done_at"),
    note: text("note"),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("group_idea_unique").on(t.groupLineageId, t.ideaLineageId)],
);

// Bad habits a group is eliminating.
export const groupHabit = sqliteTable(
  "group_habit",
  {
    id: id(),
    groupLineageId: text("group_lineage_id").notNull(),
    habitLineageId: text("habit_lineage_id").notNull(),
    createdAt: createdAt(),
  },
  t => [uniqueIndex("group_habit_unique").on(t.groupLineageId, t.habitLineageId)],
);

// Tomorrow's plan. No status ever: expiry derives from date, completion lives
// on the items. description records the user's reported state (energy /
// social / work answers) so successor plans can read it.
export const dailyPlan = sqliteTable(
  "daily_plan",
  {
    id: id(),
    weeklyPlanId: text("weekly_plan_id"), // experiment row id (weekly plan)
    date: text("date").notNull(), // YYYY-MM-DD local
    theme: text("theme"), // the work-centric one-liner
    description: text("description"),
    sourceConversationId: text("source_conversation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [index("daily_plan_date").on(t.date)],
);

// The day's concrete items; done_at is the manual dashboard CRUD and doubles
// as the habit-tracking signal.
export const dailyPlanItem = sqliteTable(
  "daily_plan_item",
  {
    id: id(),
    dailyPlanId: text("daily_plan_id")
      .notNull()
      .references(() => dailyPlan.id),
    kind: text("kind", { enum: ["block", "todo", "leisure"] }).notNull(),
    text: text("text").notNull(),
    calendarEventId: text("calendar_event_id"),
    taskLineageId: text("task_lineage_id"),
    doneAt: text("done_at"),
    createdAt: createdAt(),
  },
  t => [index("daily_plan_item_plan").on(t.dailyPlanId)],
);

// Things I like. description must state the feeling-pairing in plain text
// ("for when I'm overwhelmed: …") — planners read this row alone, never the
// pattern table; the pattern link is provenance only.
export const leisureActivity = sqliteTable("leisure_activity", {
  id: id(),
  ...versioning(),
  title: text("title").notNull(),
  counteractsPatternLineageId: text("counteracts_pattern_lineage_id"),
  fitsWhen: text("fits_when"), // free text: morning / evening / weekend …
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
