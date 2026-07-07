import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Shared column helpers — every table gets uuid id + ISO timestamps (spec §7 conventions).
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

// §7.1 — one row per chat thread; content_json is the reconstructed active path.
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
    categorizeProcessedAt: text("categorize_processed_at"),
    parseError: text("parse_error"), // reason when active-path reconstruction failed
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [
    uniqueIndex("conversation_source_external").on(t.source, t.externalId),
    index("conversation_slug_queue").on(t.slugDetected, t.categorizeProcessedAt),
  ],
);

// §7.2
export const category = sqliteTable("category", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description"),
  status: text("status", { enum: ["active", "archived"] })
    .notNull()
    .default("active"),
  topKOverride: integer("top_k_override"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// §7.3 + amendments 2/3 — pinned links are exempt from top-K auto-demotion.
export const rantLink = sqliteTable(
  "rant_link",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
    categoryId: text("category_id")
      .notNull()
      .references(() => category.id),
    activeForDerive: integer("active_for_derive", { mode: "boolean" }).notNull().default(true),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["agent", "manual"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [uniqueIndex("rant_link_convo_category").on(t.conversationId, t.categoryId)],
);

// §7.4
export const goal = sqliteTable("goal", {
  id: id(),
  categoryId: text("category_id").references(() => category.id),
  title: text("title").notNull(),
  identityClause: text("identity_clause"),
  synthesisMd: text("synthesis_md"),
  status: text("status", { enum: ["suggested", "active", "backlog", "dormant", "retired"] })
    .notNull()
    .default("suggested"),
  sortOrder: integer("sort_order").notNull().default(0),
  origin: text("origin", { enum: ["derived", "manual"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// §7.5
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

// §7.6
export const registryItem = sqliteTable("registry_item", {
  id: id(),
  kind: text("kind", { enum: ["habit", "environment", "experience"] }).notNull(),
  title: text("title").notNull(),
  note: text("note"),
  valence: text("valence", { enum: ["good", "bad"] }), // habits only
  status: text("status", { enum: ["proposed", "active", "removed"] })
    .notNull()
    .default("active"),
  sourceConversationId: text("source_conversation_id").references(() => conversation.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// §7.7 — service enforces ≤1 row in {committed, running}.
export const experiment = sqliteTable("experiment", {
  id: id(),
  title: text("title").notNull(),
  reasoningMd: text("reasoning_md"),
  goalIds: text("goal_ids").notNull().default("[]"), // json array of goal ids
  leversJson: text("levers_json").notNull().default("{}"), // {experience?, habit_changes?, environment_changes?}
  actionsJson: text("actions_json").notNull().default("[]"), // [{when, then}]
  bandwidth: text("bandwidth", { enum: ["tiny", "normal", "lots"] }).notNull(),
  status: text("status", { enum: ["draft", "committed", "running", "done", "composted"] })
    .notNull()
    .default("draft"),
  committedAt: text("committed_at"),
  endedAt: text("ended_at"),
  outcomeMd: text("outcome_md"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// §7.8 — payload_json is a self-contained mutation, incl. source_conversation_ids (amendment 8).
export const proposal = sqliteTable(
  "proposal",
  {
    id: id(),
    kind: text("kind", {
      enum: [
        "categorization",
        "goal_create",
        "goal_update",
        "goal_status",
        "registry_add",
        "registry_prune",
        "synthesis_update",
      ],
    }).notNull(),
    payloadJson: text("payload_json").notNull(),
    scopeKey: text("scope_key").notNull(), // conversation:{id} | category:{id}
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

// §7.9
export const agentRun = sqliteTable("agent_run", {
  id: id(),
  agentName: text("agent_name", { enum: ["categorizer", "deriver", "daily_writeup"] }).notNull(),
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

// §7.11 — append-only trajectory.
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

// §7.12 — typed key-value; values stored as JSON strings.
export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});

// §7.13
export const dailyWriteup = sqliteTable("daily_writeup", {
  id: id(),
  date: text("date").notNull().unique(), // YYYY-MM-DD
  text: text("text").notNull(),
  agentRunId: text("agent_run_id").references(() => agentRun.id),
  daysSinceLastVisitAtGeneration: integer("days_since_last_visit_at_generation"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
