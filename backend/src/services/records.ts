import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  environmentItem,
  experimentGroup,
  experimentGroupGoal,
  experimentIdea,
  goalHabit,
  goalPattern,
  groupHabit,
  groupIdea,
  habit,
  ideaGoal,
  ideaProject,
  leisureActivity,
  lineageParent,
  organizedGoal,
  patternOfBehavior,
  project,
  task,
} from "../db/schema";

// The versioned-record vocabulary: which models record_create can make, what
// fields each accepts, and which relationship tables link them. Everything is
// insert-only; state derives from timestamps and lineage (SCHEMA v1.2).

export const VersionedModelSchema = z.enum([
  "organized_goal",
  "habit",
  "environment_item",
  "project",
  "experiment_group",
  "pattern_of_behavior",
  "experiment_idea",
  "task",
  "leisure_activity",
]);
export type VersionedModel = z.infer<typeof VersionedModelSchema>;

type AnyTable =
  | typeof organizedGoal
  | typeof habit
  | typeof environmentItem
  | typeof project
  | typeof experimentGroup
  | typeof patternOfBehavior
  | typeof experimentIdea
  | typeof task
  | typeof leisureActivity;

// Per-model creation contract: extra fields beyond title/description, and the
// legacy not-null columns that need harmless defaults until the cleanup
// migration drops them.
const MODELS: Record<
  VersionedModel,
  { table: AnyTable; extraFields: z.ZodRawShape; legacyDefaults?: Record<string, unknown> }
> = {
  organized_goal: { table: organizedGoal, extraFields: {} },
  habit: {
    table: habit,
    // conversation-origin habits are almost always the bad ones; system
    // habits are born by picks/weekly plans, not by record_create.
    extraFields: { origin: z.enum(["conversation", "system"]).default("conversation") },
    legacyDefaults: { status: "established" },
  },
  environment_item: {
    table: environmentItem,
    extraFields: {
      habitLineageId: z.string().min(1), // REQUIRED: conversation-origin environments attach to a habit
      effect: z.enum(["easier", "harder"]),
    },
    legacyDefaults: { subKind: "physical_setup", origin: "conversation" },
  },
  project: { table: project, extraFields: {} },
  experiment_group: { table: experimentGroup, extraFields: { theme: z.string().max(500).optional() } },
  pattern_of_behavior: { table: patternOfBehavior, extraFields: {} },
  experiment_idea: { table: experimentIdea, extraFields: {} },
  task: {
    table: task,
    extraFields: {
      deadlineDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      experimentIdeaLineageId: z.string().min(1).optional(), // presence = goal-minded task
    },
  },
  leisure_activity: {
    table: leisureActivity,
    extraFields: {
      counteractsPatternLineageId: z.string().min(1).optional(),
      fitsWhen: z.string().max(300).optional(),
    },
  },
};

// Fields on create ops that reference other records by lineage id and may use
// "temp:<tempId>" to point at a record created in the same change set.
export const LINEAGE_REF_FIELDS = new Set([
  "habitLineageId",
  "experimentIdeaLineageId",
  "counteractsPatternLineageId",
]);

export function createFieldsSchema(model: VersionedModel) {
  return z
    .object({
      title: z.string().trim().min(1).max(300),
      description: z.string().trim().max(50_000).optional(),
      ...MODELS[model].extraFields,
    })
    .strict();
}

export function modelTable(model: VersionedModel): AnyTable {
  return MODELS[model].table;
}

export function lineageHead(model: VersionedModel, lineageId: string) {
  const table = MODELS[model].table;
  return db
    .select()
    .from(table)
    .where(eq(table.lineageId, lineageId))
    .orderBy(desc(table.version))
    .limit(1)
    .get();
}

export type InsertVersionInput = {
  model: VersionedModel;
  fields: Record<string, unknown>;
  // new lineage when omitted; a version bump when set
  lineage?: { lineageId: string; prevVersionId: string; version: number };
  // remix parentage: rows written to lineage_parent for a NEW lineage
  parents?: { type: string; versionId: string }[];
};

/** Insert one immutable version row. Returns {versionId, lineageId}. */
export function insertVersionRow(input: InsertVersionInput): { versionId: string; lineageId: string } {
  const { table, legacyDefaults } = MODELS[input.model];
  const id = crypto.randomUUID();
  const lineageId = input.lineage?.lineageId ?? id;
  db.insert(table)
    .values({
      ...(legacyDefaults ?? {}),
      ...input.fields,
      id,
      lineageId,
      version: input.lineage?.version ?? 1,
      prevVersionId: input.lineage?.prevVersionId ?? null,
    } as never)
    .run();
  for (const parent of input.parents ?? []) {
    db.insert(lineageParent)
      .values({
        childType: input.model,
        childLineageId: lineageId,
        parentType: parent.type,
        parentVersionId: parent.versionId,
      })
      .run();
  }
  return { versionId: id, lineageId };
}

// Relationship registry: link ops write these rows. from/to store lineage ids
// (legacy column names kept where the table is repurposed).
export const RelationSchema = z.enum([
  "idea_goal",
  "goal_habit",
  "goal_pattern",
  "idea_project",
  "group_idea",
  "group_habit",
  "group_goal",
]);
export type Relation = z.infer<typeof RelationSchema>;

const RELATIONS: Record<
  Relation,
  { insert: (from: string, to: string, opts: { description?: string; rank?: number }) => void }
> = {
  idea_goal: {
    insert: (from, to, o) =>
      db.insert(ideaGoal).values({ ideaLineageId: from, goalLineageId: to, description: o.description ?? null }).onConflictDoNothing().run(),
  },
  goal_habit: {
    insert: (from, to, o) =>
      db.insert(goalHabit).values({ goalId: from, habitId: to, description: o.description ?? null }).onConflictDoNothing().run(),
  },
  goal_pattern: {
    insert: (from, to) =>
      db.insert(goalPattern).values({ goalLineageId: from, patternLineageId: to }).onConflictDoNothing().run(),
  },
  idea_project: {
    insert: (from, to) =>
      db.insert(ideaProject).values({ ideaLineageId: from, projectLineageId: to }).onConflictDoNothing().run(),
  },
  group_idea: {
    insert: (from, to) => db.insert(groupIdea).values({ groupLineageId: from, ideaLineageId: to }).onConflictDoNothing().run(),
  },
  group_habit: {
    insert: (from, to) => db.insert(groupHabit).values({ groupLineageId: from, habitLineageId: to }).onConflictDoNothing().run(),
  },
  group_goal: {
    insert: (from, to, o) =>
      db
        .insert(experimentGroupGoal)
        .values({ experimentGroupId: from, organizedGoalId: to, rank: o.rank ?? null })
        .onConflictDoNothing()
        .run(),
  },
};

export function insertRelation(relation: Relation, from: string, to: string, opts: { description?: string; rank?: number } = {}) {
  RELATIONS[relation].insert(from, to, opts);
}

/** Search a model's lineage heads by fuzzy title/description tokens — the
 * deterministic half of reconciliation, and read_record's list search. */
export function searchModel(model: VersionedModel, query: string, limit = 5) {
  const table = MODELS[model].table;
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 3);
  const rows = db.select().from(table).all() as {
    id: string;
    lineageId: string | null;
    version: number | null;
    title: string;
    description: string | null;
  }[];
  // lineage heads only
  const heads = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = row.lineageId ?? row.id;
    const prev = heads.get(key);
    if (!prev || (row.version ?? 1) > (prev.version ?? 1)) heads.set(key, row);
  }
  const scored = [...heads.values()]
    .map(row => {
      const haystack = `${row.title} ${row.description ?? ""}`.toLowerCase();
      const score = tokens.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
      return { row, score };
    })
    .filter(x => (tokens.length ? x.score > 0 : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(x => ({
    lineageId: x.row.lineageId ?? x.row.id,
    versionId: x.row.id,
    version: x.row.version ?? 1,
    title: x.row.title,
    description: x.row.description,
  }));
}
