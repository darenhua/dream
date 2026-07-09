import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  status: text("status", {
    enum: ["queued", "scheduling", "running", "succeeded", "failed", "archived"],
  })
    .notNull()
    .default("queued"),
  proposalId: text("proposal_id").references(() => proposal.id),
  bandwidth: text("bandwidth"), // free text captured during the scheduling chat
  plannedDurationDays: integer("planned_duration_days"), // stored, never enforced
  planJson: text("plan_json"), // the committed SchedulePlan artifact
  queuedAt: text("queued_at"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  outcomeMd: text("outcome_md"), // self-reported notes at end
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

// One-off deliverables of an experiment (experiences to have, things to buy,
// environment setup); recurring habit blocks live on the habit rows instead.
export const experimentTask = sqliteTable("experiment_task", {
  id: id(),
  experimentId: text("experiment_id")
    .notNull()
    .references(() => experiment.id),
  kind: text("kind", { enum: ["experience", "purchase", "setup"] }).notNull(),
  title: text("title").notNull(),
  detail: text("detail"),
  status: text("status", { enum: ["pending", "scheduled", "done", "skipped"] })
    .notNull()
    .default("pending"),
  scheduledFor: text("scheduled_for"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// The in-dashboard schedule-agent conversation for activating an experiment.
export const chatSession = sqliteTable("chat_session", {
  id: id(),
  purpose: text("purpose", { enum: ["schedule"] }).notNull().default("schedule"),
  experimentId: text("experiment_id").references(() => experiment.id),
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
    kind: text("kind", {
      enum: [
        "goal_create",
        "goal_update",
        "goal_status",
        "synthesis_update",
        "habit_add",
        "habit_update",
        "habit_prune",
        "environment_add",
        "environment_update",
        "environment_prune",
        "experience_add",
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
    enum: ["distiller", "deriver", "schedule_agent", "prompt_generator", "daily_writeup"],
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
