import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  collaborationWorkspace,
  conversation,
  environmentItem,
  experience,
  experiment,
  experimentGoal,
  experimentGroup,
  experimentGroupContext,
  experimentGroupGoal,
  experimentGroupProject,
  experimentGroupSource,
  experimentGroupTarget,
  experimentOrganizedGoal,
  experimentTask,
  experimentTaskGoal,
  extraction,
  extractionLink,
  goal,
  habit,
  organizedEnvironmentItem,
  organizedGoal,
  organizedGoalSource,
  organizedHabit,
  organizedRegistrySource,
  project,
} from "../db/schema";
import { createHabit } from "./habits";

export const CollaborationModeSchema = z.enum([
  "organized_goal",
  "organized_habit",
  "organized_environment",
  "experiment_group",
  "actionable_experiment",
]);
export type CollaborationMode = z.infer<typeof CollaborationModeSchema>;

export const SourceRefSchema = z.object({
  entityType: z.enum(["goal", "habit", "environment_item", "experience", "experiment", "project"]),
  entityId: z.string().uuid(),
  // Draft-only explanation for why this raw record is relevant. The durable
  // provenance joins intentionally retain only the stable entity reference.
  note: z.string().max(2_000).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

const GoalOperationSchema = z.object({
  type: z.literal("upsert_organized_goal"),
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(300),
  identityClause: z.string().max(2_000).nullable().optional(),
  synthesisMd: z.string().max(30_000).nullable().optional(),
  priorityRank: z.number().int().nonnegative().nullable().optional(),
  status: z.enum(["active", "sunset"]).optional(),
  sources: z.array(SourceRefSchema).max(200).optional(),
});

const HabitOperationSchema = z.object({
  type: z.literal("upsert_organized_habit"),
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(300),
  note: z.string().max(10_000).nullable().optional(),
  synthesisMd: z.string().max(30_000).nullable().optional(),
  status: z.enum(["active", "sunset"]).optional(),
  sources: z.array(SourceRefSchema).max(200).optional(),
});

const EnvironmentOperationSchema = z.object({
  type: z.literal("upsert_organized_environment"),
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(300),
  note: z.string().max(10_000).nullable().optional(),
  synthesisMd: z.string().max(30_000).nullable().optional(),
  status: z.enum(["active", "sunset"]).optional(),
  sources: z.array(SourceRefSchema).max(200).optional(),
});

const GroupTargetSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(["habit", "environment", "experience", "project"]),
  title: z.string().min(1).max(300),
  detailMd: z.string().max(10_000).nullable().optional(),
  status: z.enum(["pending", "done"]).optional(),
});

const GroupOperationSchema = z.object({
  type: z.literal("upsert_experiment_group"),
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(300),
  motivationMd: z.string().max(50_000).nullable().optional(),
  status: z.enum(["active", "done", "sunset"]).optional(),
  closingReviewMd: z.string().max(30_000).nullable().optional(),
  organizedGoalIds: z.array(z.string().uuid()).min(1).max(30),
  targets: z.array(GroupTargetSchema).max(100).optional(),
  appendContext: z.array(z.string().min(1).max(30_000)).max(50).optional(),
  projectIds: z.array(z.string().uuid()).max(100).optional(),
  sources: z.array(SourceRefSchema).max(200).optional(),
});

const ActionableTaskSchema = z.object({
  kind: z.enum(["experience", "purchase", "setup", "project", "momentum"]),
  title: z.string().min(1).max(300),
  detail: z.string().max(10_000).nullable().optional(),
  scheduleMode: z.enum(["calendar", "none"]),
  scheduledFor: z.string().datetime().nullable().optional(),
  rawGoalIds: z.array(z.string().uuid()).max(30).optional(),
});

const HabitBlockSchema = z.object({
  title: z.string().min(1).max(300),
  note: z.string().max(10_000).nullable().optional(),
  rrule: z.string().max(1_000).nullable().optional(),
  preferredTime: z.string().max(20).nullable().optional(),
  durationMinutes: z.number().int().positive().max(1_440).nullable().optional(),
  scheduleMode: z.enum(["calendar", "none"]),
  rawGoalIds: z.array(z.string().uuid()).max(30).optional(),
});

const ActionableWeekOfSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
  }, "weekOf must be a valid Monday in YYYY-MM-DD form");

const ActionableOperationSchema = z.object({
  type: z.literal("create_actionable_experiment"),
  experimentGroupId: z.string().uuid(),
  title: z.string().min(1).max(300),
  hypothesisMd: z.string().max(30_000).nullable().optional(),
  weekOf: ActionableWeekOfSchema,
  organizedGoalIds: z.array(z.string().uuid()).min(1).max(30),
  tasks: z.array(ActionableTaskSchema).max(100).default([]),
  habitBlocks: z.array(HabitBlockSchema).max(30).default([]),
});

const GroupTargetDoneOperationSchema = z.object({
  type: z.literal("set_group_target_done"),
  targetId: z.string().uuid(),
  done: z.boolean(),
});

export const DraftOperationSchema = z.discriminatedUnion("type", [
  GoalOperationSchema,
  HabitOperationSchema,
  EnvironmentOperationSchema,
  GroupOperationSchema,
  ActionableOperationSchema,
  GroupTargetDoneOperationSchema,
]);
export const DraftOperationsSchema = z.array(DraftOperationSchema).min(1).max(100);
export type DraftOperation = z.infer<typeof DraftOperationSchema>;

function rawEntityExists(source: SourceRef): boolean {
  switch (source.entityType) {
    case "goal":
      return Boolean(db.select({ id: goal.id }).from(goal).where(eq(goal.id, source.entityId)).get());
    case "habit":
      return Boolean(db.select({ id: habit.id }).from(habit).where(eq(habit.id, source.entityId)).get());
    case "environment_item":
      return Boolean(db.select({ id: environmentItem.id }).from(environmentItem).where(eq(environmentItem.id, source.entityId)).get());
    case "experience":
      return Boolean(db.select({ id: experience.id }).from(experience).where(eq(experience.id, source.entityId)).get());
    case "experiment":
      return Boolean(db.select({ id: experiment.id }).from(experiment).where(eq(experiment.id, source.entityId)).get());
    case "project":
      return Boolean(db.select({ id: project.id }).from(project).where(eq(project.id, source.entityId)).get());
  }
}

// Draft-level source references are review evidence as well as durable links,
// so even a source used only in the markdown/audit layer must name a real raw
// record. Operation sources are still rechecked at transaction apply time.
export function assertSourcesExist(sources: SourceRef[]) {
  for (const source of sources) {
    if (!rawEntityExists(source)) throw new Error(`source ${source.entityType}:${source.entityId} does not exist`);
  }
}

function replaceGoalSources(organizedGoalId: string, sources: SourceRef[]) {
  assertSourcesExist(sources);
  db.delete(organizedGoalSource).where(eq(organizedGoalSource.organizedGoalId, organizedGoalId)).run();
  for (const source of sources) {
    db.insert(organizedGoalSource).values({ organizedGoalId, entityType: source.entityType, entityId: source.entityId }).run();
  }
}

function replaceRegistrySources(
  organizedEntityType: "habit" | "environment",
  organizedEntityId: string,
  sources: SourceRef[],
) {
  assertSourcesExist(sources);
  db
    .delete(organizedRegistrySource)
    .where(
      and(
        eq(organizedRegistrySource.organizedEntityType, organizedEntityType),
        eq(organizedRegistrySource.organizedEntityId, organizedEntityId),
      ),
    )
    .run();
  for (const source of sources) {
    db.insert(organizedRegistrySource)
      .values({ organizedEntityType, organizedEntityId, rawEntityType: source.entityType, rawEntityId: source.entityId })
      .run();
  }
}

function assertExistingIds<T extends { id: string }>(rows: T[], ids: string[], label: string) {
  const known = new Set(rows.map(row => row.id));
  const missing = ids.filter(id => !known.has(id));
  if (missing.length) throw new Error(`${label} not found: ${missing.join(", ")}`);
}

function rawGoalIdsForOrganizedGoals(organizedGoalIds: string[]): string[] {
  if (!organizedGoalIds.length) return [];
  return db
    .select({ entityId: organizedGoalSource.entityId })
    .from(organizedGoalSource)
    .where(and(inArray(organizedGoalSource.organizedGoalId, organizedGoalIds), eq(organizedGoalSource.entityType, "goal")))
    .all()
    .map(row => row.entityId);
}

function resolveRawGoalIds(requested: string[] | undefined, fallback: string[]): string[] {
  const ids = requested?.length ? requested : fallback;
  if (!ids.length) return [];
  const existing = db.select({ id: goal.id }).from(goal).where(inArray(goal.id, ids)).all();
  assertExistingIds(existing, ids, "raw goal");
  return [...new Set(ids)];
}

function upsertGoal(op: z.infer<typeof GoalOperationSchema>): string {
  const existing = op.id ? db.select().from(organizedGoal).where(eq(organizedGoal.id, op.id)).get() : null;
  if (op.id && !existing) throw new Error("organized goal not found");
  const row = existing
    ? db
        .update(organizedGoal)
        .set({
          title: op.title,
          identityClause: op.identityClause ?? existing.identityClause,
          synthesisMd: op.synthesisMd ?? existing.synthesisMd,
          priorityRank: op.priorityRank === undefined ? existing.priorityRank : op.priorityRank,
          status: op.status ?? existing.status,
        })
        .where(eq(organizedGoal.id, existing.id))
        .returning()
        .get()
    : db
        .insert(organizedGoal)
        .values({
          title: op.title,
          identityClause: op.identityClause ?? null,
          synthesisMd: op.synthesisMd ?? null,
          priorityRank: op.priorityRank ?? null,
          status: op.status ?? "active",
        })
        .returning()
        .get();
  if (op.sources) replaceGoalSources(row.id, op.sources);
  return row.id;
}

function upsertHabit(op: z.infer<typeof HabitOperationSchema>): string {
  const existing = op.id ? db.select().from(organizedHabit).where(eq(organizedHabit.id, op.id)).get() : null;
  if (op.id && !existing) throw new Error("organized habit not found");
  const row = existing
    ? db
        .update(organizedHabit)
        .set({ title: op.title, note: op.note ?? existing.note, synthesisMd: op.synthesisMd ?? existing.synthesisMd, status: op.status ?? existing.status })
        .where(eq(organizedHabit.id, existing.id))
        .returning()
        .get()
    : db
        .insert(organizedHabit)
        .values({ title: op.title, note: op.note ?? null, synthesisMd: op.synthesisMd ?? null, status: op.status ?? "active" })
        .returning()
        .get();
  if (op.sources) replaceRegistrySources("habit", row.id, op.sources);
  return row.id;
}

function upsertEnvironment(op: z.infer<typeof EnvironmentOperationSchema>): string {
  const existing = op.id
    ? db.select().from(organizedEnvironmentItem).where(eq(organizedEnvironmentItem.id, op.id)).get()
    : null;
  if (op.id && !existing) throw new Error("organized environment item not found");
  const row = existing
    ? db
        .update(organizedEnvironmentItem)
        .set({ title: op.title, note: op.note ?? existing.note, synthesisMd: op.synthesisMd ?? existing.synthesisMd, status: op.status ?? existing.status })
        .where(eq(organizedEnvironmentItem.id, existing.id))
        .returning()
        .get()
    : db
        .insert(organizedEnvironmentItem)
        .values({ title: op.title, note: op.note ?? null, synthesisMd: op.synthesisMd ?? null, status: op.status ?? "active" })
        .returning()
        .get();
  if (op.sources) replaceRegistrySources("environment", row.id, op.sources);
  return row.id;
}

function upsertGroup(op: z.infer<typeof GroupOperationSchema>, changeSetId: string): string {
  assertExistingIds(
    db.select({ id: organizedGoal.id }).from(organizedGoal).where(inArray(organizedGoal.id, op.organizedGoalIds)).all(),
    op.organizedGoalIds,
    "organized goal",
  );
  if (op.projectIds?.length) {
    assertExistingIds(
      db.select({ id: project.id }).from(project).where(inArray(project.id, op.projectIds)).all(),
      op.projectIds,
      "project",
    );
  }
  const existing = op.id ? db.select().from(experimentGroup).where(eq(experimentGroup.id, op.id)).get() : null;
  if (op.id && !existing) throw new Error("experiment group not found");
  const row = existing
    ? db
        .update(experimentGroup)
        .set({
          title: op.title,
          motivationMd: op.motivationMd ?? existing.motivationMd,
          status: op.status ?? existing.status,
          closingReviewMd: op.closingReviewMd ?? existing.closingReviewMd,
        })
        .where(eq(experimentGroup.id, existing.id))
        .returning()
        .get()
    : db
        .insert(experimentGroup)
        .values({
          title: op.title,
          motivationMd: op.motivationMd ?? null,
          status: op.status ?? "active",
          closingReviewMd: op.closingReviewMd ?? null,
        })
        .returning()
        .get();

  db.delete(experimentGroupGoal).where(eq(experimentGroupGoal.experimentGroupId, row.id)).run();
  for (const organizedGoalId of op.organizedGoalIds) {
    db.insert(experimentGroupGoal).values({ experimentGroupId: row.id, organizedGoalId }).run();
  }
  if (op.projectIds) {
    db.delete(experimentGroupProject).where(eq(experimentGroupProject.experimentGroupId, row.id)).run();
    for (const projectId of op.projectIds) db.insert(experimentGroupProject).values({ experimentGroupId: row.id, projectId }).run();
  }
  if (op.sources) {
    assertSourcesExist(op.sources);
    db.delete(experimentGroupSource).where(eq(experimentGroupSource.experimentGroupId, row.id)).run();
    for (const source of op.sources) {
      db.insert(experimentGroupSource)
        .values({ experimentGroupId: row.id, entityType: source.entityType, entityId: source.entityId })
        .run();
    }
  }
  if (op.targets) {
    db.delete(experimentGroupTarget).where(eq(experimentGroupTarget.experimentGroupId, row.id)).run();
    for (const target of op.targets) {
      db.insert(experimentGroupTarget)
        .values({
          id: target.id,
          experimentGroupId: row.id,
          kind: target.kind,
          title: target.title,
          detailMd: target.detailMd ?? null,
          status: target.status ?? "pending",
          doneAt: target.status === "done" ? new Date().toISOString() : null,
        })
        .run();
    }
  }
  for (const textMd of op.appendContext ?? []) {
    db.insert(experimentGroupContext).values({ experimentGroupId: row.id, textMd, sourceChangeSetId: changeSetId }).run();
  }
  return row.id;
}

function createActionable(op: z.infer<typeof ActionableOperationSchema>): string {
  const group = db.select().from(experimentGroup).where(eq(experimentGroup.id, op.experimentGroupId)).get();
  if (!group) throw new Error("experiment group not found");
  if (group.status !== "active") throw new Error(`experiment group is ${group.status}, not active`);
  const groupGoalIds = db
    .select({ organizedGoalId: experimentGroupGoal.organizedGoalId })
    .from(experimentGroupGoal)
    .where(eq(experimentGroupGoal.experimentGroupId, group.id))
    .all()
    .map(row => row.organizedGoalId);
  const outOfGroup = op.organizedGoalIds.filter(id => !groupGoalIds.includes(id));
  if (outOfGroup.length) {
    throw new Error(`actionable goals must be selected by its group: ${outOfGroup.join(", ")}`);
  }
  assertExistingIds(
    db.select({ id: organizedGoal.id }).from(organizedGoal).where(inArray(organizedGoal.id, op.organizedGoalIds)).all(),
    op.organizedGoalIds,
    "organized goal",
  );
  const duplicate = db
    .select({ id: experiment.id })
    .from(experiment)
    .where(
      and(
        eq(experiment.kind, "actionable"),
        eq(experiment.experimentGroupId, op.experimentGroupId),
        eq(experiment.weekOf, op.weekOf),
        inArray(experiment.status, ["queued", "scheduling", "running"]),
      ),
    )
    .get();
  if (duplicate) throw new Error("this group already has a live actionable for that week");

  const rawGoalIds = resolveRawGoalIds(undefined, rawGoalIdsForOrganizedGoals(op.organizedGoalIds));
  const row = db
    .insert(experiment)
    .values({
      title: op.title,
      hypothesisMd: op.hypothesisMd ?? null,
      kind: "actionable",
      experimentGroupId: group.id,
      weekOf: op.weekOf,
      plannedDurationDays: 7,
      status: "queued",
      queuedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  for (const organizedGoalId of op.organizedGoalIds) {
    db.insert(experimentOrganizedGoal).values({ experimentId: row.id, organizedGoalId }).run();
  }
  for (const goalId of rawGoalIds) db.insert(experimentGoal).values({ experimentId: row.id, goalId }).onConflictDoNothing().run();

  for (const taskInput of op.tasks) {
    if (taskInput.scheduleMode === "calendar" && !taskInput.scheduledFor) {
      throw new Error(`calendar task "${taskInput.title}" needs scheduledFor`);
    }
    const task = db
      .insert(experimentTask)
      .values({
        experimentId: row.id,
        kind: taskInput.kind,
        title: taskInput.title,
        detail: taskInput.detail ?? null,
        status: "pending",
        scheduleMode: taskInput.scheduleMode,
        scheduledFor: taskInput.scheduleMode === "calendar" ? (taskInput.scheduledFor ?? null) : null,
      })
      .returning()
      .get();
    for (const goalId of resolveRawGoalIds(taskInput.rawGoalIds, rawGoalIds)) {
      db.insert(experimentTaskGoal).values({ experimentTaskId: task.id, goalId }).onConflictDoNothing().run();
    }
  }
  for (const habitBlock of op.habitBlocks) {
    if (habitBlock.scheduleMode === "calendar" && (!habitBlock.rrule || !habitBlock.preferredTime)) {
      throw new Error(`calendar habit block "${habitBlock.title}" needs an rrule and preferredTime`);
    }
    const habitRow = createHabit({
      title: habitBlock.title,
      note: habitBlock.note ?? null,
      status: "building",
      rrule: habitBlock.rrule ?? null,
      preferredTime: habitBlock.preferredTime ?? null,
      durationMinutes: habitBlock.durationMinutes ?? null,
      experimentId: row.id,
      origin: "experiment",
      goalIds: resolveRawGoalIds(habitBlock.rawGoalIds, rawGoalIds),
    });
    // "none" is represented by an absent rrule so the calendar confirmation
    // service can safely ignore it. Calendar-backed habits retain their rrule.
    if (habitBlock.scheduleMode === "none" && habitRow.rrule) {
      db.update(habit).set({ rrule: null, preferredTime: null, durationMinutes: null }).where(eq(habit.id, habitRow.id)).run();
    }
  }
  return row.id;
}

/** Applies only a previously reviewed draft. Call inside the change-set transaction. */
export function applyDraftOperations(operationsJson: unknown, changeSetId: string): { primaryIds: string[] } {
  const operations = DraftOperationsSchema.parse(operationsJson);
  const primaryIds: string[] = [];
  for (const op of operations) {
    switch (op.type) {
      case "upsert_organized_goal":
        primaryIds.push(upsertGoal(op));
        break;
      case "upsert_organized_habit":
        primaryIds.push(upsertHabit(op));
        break;
      case "upsert_organized_environment":
        primaryIds.push(upsertEnvironment(op));
        break;
      case "upsert_experiment_group":
        primaryIds.push(upsertGroup(op, changeSetId));
        break;
      case "create_actionable_experiment":
        primaryIds.push(createActionable(op));
        break;
      case "set_group_target_done": {
        const target = db.select().from(experimentGroupTarget).where(eq(experimentGroupTarget.id, op.targetId)).get();
        if (!target) throw new Error("experiment group target not found");
        db
          .update(experimentGroupTarget)
          .set({ status: op.done ? "done" : "pending", doneAt: op.done ? new Date().toISOString() : null })
          .where(eq(experimentGroupTarget.id, target.id))
          .run();
        primaryIds.push(target.experimentGroupId);
        break;
      }
    }
  }
  return { primaryIds };
}

function sourcesFor(entityType: "goal" | "habit" | "environment", entityId: string): SourceRef[] {
  if (entityType === "goal") {
    return db
      .select({ entityType: organizedGoalSource.entityType, entityId: organizedGoalSource.entityId })
      .from(organizedGoalSource)
      .where(eq(organizedGoalSource.organizedGoalId, entityId))
      .all() as SourceRef[];
  }
  return db
    .select({ entityType: organizedRegistrySource.rawEntityType, entityId: organizedRegistrySource.rawEntityId })
    .from(organizedRegistrySource)
    .where(
      and(
        eq(organizedRegistrySource.organizedEntityType, entityType),
        eq(organizedRegistrySource.organizedEntityId, entityId),
      ),
    )
    .all() as SourceRef[];
}

function sourceLabel(source: SourceRef) {
  switch (source.entityType) {
    case "goal":
      return db.select({ title: goal.title }).from(goal).where(eq(goal.id, source.entityId)).get()?.title ?? "raw goal";
    case "habit":
      return db.select({ title: habit.title }).from(habit).where(eq(habit.id, source.entityId)).get()?.title ?? "raw habit";
    case "environment_item":
      return (
        db.select({ title: environmentItem.title }).from(environmentItem).where(eq(environmentItem.id, source.entityId)).get()?.title ??
        "raw environment"
      );
    case "experience":
      return db.select({ title: experience.title }).from(experience).where(eq(experience.id, source.entityId)).get()?.title ?? "raw experience";
    case "experiment":
      return db.select({ title: experiment.title }).from(experiment).where(eq(experiment.id, source.entityId)).get()?.title ?? "experiment candidate";
    case "project":
      return db.select({ title: project.title }).from(project).where(eq(project.id, source.entityId)).get()?.title ?? "project";
  }
}

function sourceExtractions(sources: SourceRef[]) {
  const byId = new Map<string, { x: typeof extraction.$inferSelect; conversationTitle: string | null; conversationDate: string | null }>();
  for (const source of sources) {
    const rows = db
      .select({ x: extraction, conversationTitle: conversation.title, conversationDate: conversation.sourceUpdatedAt })
      .from(extractionLink)
      .innerJoin(extraction, eq(extractionLink.extractionId, extraction.id))
      .innerJoin(conversation, eq(extraction.conversationId, conversation.id))
      .where(and(eq(extractionLink.entityType, source.entityType), eq(extractionLink.entityId, source.entityId)))
      .all();
    for (const row of rows) byId.set(row.x.id, row);
  }
  return [...byId.values()].map(row => ({ ...row.x, conversationTitle: row.conversationTitle, conversationDate: row.conversationDate }));
}

function groupView(row: typeof experimentGroup.$inferSelect) {
  const goals = db
    .select({ id: organizedGoal.id, title: organizedGoal.title, priorityRank: organizedGoal.priorityRank, status: organizedGoal.status })
    .from(experimentGroupGoal)
    .innerJoin(organizedGoal, eq(experimentGroupGoal.organizedGoalId, organizedGoal.id))
    .where(eq(experimentGroupGoal.experimentGroupId, row.id))
    .all();
  const targets = db
    .select()
    .from(experimentGroupTarget)
    .where(eq(experimentGroupTarget.experimentGroupId, row.id))
    .orderBy(asc(experimentGroupTarget.createdAt))
    .all();
  const projects = db
    .select({ id: project.id, title: project.title, note: project.note })
    .from(experimentGroupProject)
    .innerJoin(project, eq(experimentGroupProject.projectId, project.id))
    .where(eq(experimentGroupProject.experimentGroupId, row.id))
    .all();
  const actionables = db
    .select()
    .from(experiment)
    .where(and(eq(experiment.kind, "actionable"), eq(experiment.experimentGroupId, row.id)))
    .orderBy(desc(experiment.weekOf), desc(experiment.createdAt))
    .all();
  return { ...row, goals, targets, projects, projectCount: projects.length, actionables };
}

export function organizedFeed() {
  // The curated feed keeps sunsets inspectable. They are out of the editable
  // priority partition, but hiding them would sever the user's own history
  // and make a later deliberate revival impossible from the dashboard.
  const goals = db.select().from(organizedGoal).all();
  const activeGoals = goals.filter(row => row.status === "active");
  const orderedGoals = [...activeGoals].sort((a, b) => {
    if (a.priorityRank === null && b.priorityRank === null) return a.createdAt.localeCompare(b.createdAt);
    if (a.priorityRank === null) return 1;
    if (b.priorityRank === null) return -1;
    return a.priorityRank - b.priorityRank;
  });
  const sunsetGoals = goals.filter(row => row.status === "sunset").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const organizedHabits = db.select().from(organizedHabit).orderBy(asc(organizedHabit.createdAt)).all();
  const environment = db.select().from(organizedEnvironmentItem).orderBy(asc(organizedEnvironmentItem.createdAt)).all();
  const groups = db.select().from(experimentGroup).orderBy(desc(experimentGroup.updatedAt)).all().map(groupView);
  const actionables = db
    .select()
    .from(experiment)
    .where(eq(experiment.kind, "actionable"))
    .orderBy(desc(experiment.weekOf), desc(experiment.createdAt))
    .all()
    .map(row => {
      const tasks = db.select().from(experimentTask).where(eq(experimentTask.experimentId, row.id)).all();
      const groupTitle = row.experimentGroupId
        ? db.select({ title: experimentGroup.title }).from(experimentGroup).where(eq(experimentGroup.id, row.experimentGroupId)).get()?.title ?? null
        : null;
      return {
        ...row,
        groupTitle,
        tasks,
        taskSummary: {
          total: tasks.length,
          done: tasks.filter(task => task.status === "done").length,
          scheduled: tasks.filter(task => task.status === "scheduled").length,
        },
      };
    });
  return {
    goals: [...orderedGoals, ...sunsetGoals].map(row => ({ ...row, sources: sourcesFor("goal", row.id) })),
    habits: organizedHabits.map(row => ({ ...row, sources: sourcesFor("habit", row.id) })),
    environment: environment.map(row => ({ ...row, sources: sourcesFor("environment", row.id) })),
    groups,
    actionables,
  };
}

export function organizedEntityDetail(type: "goal" | "habit" | "environment" | "group", id: string) {
  if (type === "goal") {
    const row = db.select().from(organizedGoal).where(eq(organizedGoal.id, id)).get();
    return row ? { ...row, sources: sourcesFor("goal", id), contexts: [] } : null;
  }
  if (type === "habit") {
    const row = db.select().from(organizedHabit).where(eq(organizedHabit.id, id)).get();
    return row ? { ...row, sources: sourcesFor("habit", id), contexts: [] } : null;
  }
  if (type === "environment") {
    const row = db.select().from(organizedEnvironmentItem).where(eq(organizedEnvironmentItem.id, id)).get();
    return row ? { ...row, sources: sourcesFor("environment", id), contexts: [] } : null;
  }
  const row = db.select().from(experimentGroup).where(eq(experimentGroup.id, id)).get();
  if (!row) return null;
  const contexts = db
    .select()
    .from(experimentGroupContext)
    .where(eq(experimentGroupContext.experimentGroupId, id))
    .orderBy(asc(experimentGroupContext.createdAt))
    .all();
  const sources = db
    .select({ entityType: experimentGroupSource.entityType, entityId: experimentGroupSource.entityId })
    .from(experimentGroupSource)
    .where(eq(experimentGroupSource.experimentGroupId, id))
    .all() as SourceRef[];
  return { ...groupView(row), sources, contexts };
}

/** Dashboard detail envelope: an organized item, its raw-source bridge, and
 * the existing raw entity → extraction → conversation provenance chain. */
export function organizedDetailPayload(
  type: "organized_goal" | "organized_habit" | "organized_environment" | "experiment_group" | "actionable_experiment",
  id: string,
) {
  if (type === "actionable_experiment") {
    const row = db.select().from(experiment).where(and(eq(experiment.id, id), eq(experiment.kind, "actionable"))).get();
    if (!row) return null;
    const organizedGoalIds = db
      .select({ organizedGoalId: experimentOrganizedGoal.organizedGoalId })
      .from(experimentOrganizedGoal)
      .where(eq(experimentOrganizedGoal.experimentId, row.id))
      .all()
      .map(item => item.organizedGoalId);
    const sources = organizedGoalIds.length
      ? (db
          .select({ entityType: organizedGoalSource.entityType, entityId: organizedGoalSource.entityId })
          .from(organizedGoalSource)
          .where(inArray(organizedGoalSource.organizedGoalId, organizedGoalIds))
          .all() as SourceRef[])
      : [];
    return {
      entityType: type,
      entity: {
        ...row,
        tasks: db.select().from(experimentTask).where(eq(experimentTask.experimentId, row.id)).orderBy(asc(experimentTask.createdAt)).all(),
      },
      sources: sources.map(source => ({ ...source, title: sourceLabel(source) })),
      extractions: sourceExtractions(sources),
    };
  }
  const entity = organizedEntityDetail(
    type === "organized_goal"
      ? "goal"
      : type === "organized_habit"
        ? "habit"
        : type === "organized_environment"
          ? "environment"
          : "group",
    id,
  );
  if (!entity) return null;
  const directSources = entity.sources as SourceRef[];
  // Group goal links are also provenance: the group was explicitly built to
  // serve these organized goals, whose raw sources should remain inspectable.
  const groupGoalSources = type === "experiment_group" && "goals" in entity
    ? (entity.goals as { id: string }[]).flatMap(goalRow => sourcesFor("goal", goalRow.id))
    : [];
  const sources = [...new Map([...directSources, ...groupGoalSources].map(source => [`${source.entityType}:${source.entityId}`, source])).values()];
  return {
    entityType: type,
    entity,
    sources: sources.map(source => ({ ...source, title: sourceLabel(source) })),
    extractions: sourceExtractions(sources),
  };
}

export function reorderOrganizedGoalPriority(prioritizedIds: string[], outOfPriorityIds: string[]): boolean {
  const rows = db.select({ id: organizedGoal.id }).from(organizedGoal).where(eq(organizedGoal.status, "active")).all();
  const expected = new Set(rows.map(row => row.id));
  const supplied = [...prioritizedIds, ...outOfPriorityIds];
  if (supplied.length !== expected.size || new Set(supplied).size !== supplied.length || supplied.some(id => !expected.has(id))) {
    return false;
  }
  db.transaction(() => {
    for (const [index, id] of prioritizedIds.entries()) {
      db.update(organizedGoal).set({ priorityRank: index }).where(eq(organizedGoal.id, id)).run();
    }
    for (const id of outOfPriorityIds) db.update(organizedGoal).set({ priorityRank: null }).where(eq(organizedGoal.id, id)).run();
  });
  return true;
}

export function closeExperimentGroup(id: string, status: "done" | "sunset", closingReviewMd?: string | null) {
  const row = db.select().from(experimentGroup).where(eq(experimentGroup.id, id)).get();
  if (!row) return null;
  // A group is the parent of its weekly actionables. Closing it while a child
  // is still queued/running would make that child impossible to start (and
  // leave the user with no coherent ending record). The user can explicitly
  // archive an unstarted week or end the running week first, then close the
  // long-lived group on their own terms.
  const liveActionable = db
    .select({ id: experiment.id, title: experiment.title, status: experiment.status })
    .from(experiment)
    .where(
      and(
        eq(experiment.kind, "actionable"),
        eq(experiment.experimentGroupId, id),
        inArray(experiment.status, ["queued", "scheduling", "running"]),
      ),
    )
    .get();
  if (liveActionable) {
    throw new Error(`resolve weekly actionable \"${liveActionable.title}\" (${liveActionable.status}) before closing this group`);
  }
  return db
    .update(experimentGroup)
    .set({ status, closingReviewMd: closingReviewMd ?? row.closingReviewMd })
    .where(eq(experimentGroup.id, id))
    .returning()
    .get();
}

export function markExperimentGroupTarget(experimentGroupId: string, id: string, done: boolean) {
  const row = db.select().from(experimentGroupTarget).where(eq(experimentGroupTarget.id, id)).get();
  if (!row || row.experimentGroupId !== experimentGroupId) return null;
  return db
    .update(experimentGroupTarget)
    .set({ status: done ? "done" : "pending", doneAt: done ? new Date().toISOString() : null })
    .where(eq(experimentGroupTarget.id, id))
    .returning()
    .get();
}

// Read model used by MCP: source IDs plus confirmed extraction/conversation
// references can be expanded by the MCP transport without granting generic DB
// writes.
export function confirmedExtractionSources(sourceRefs: SourceRef[]) {
  const pairs = sourceRefs.flatMap(source =>
    db
      .select({ extractionId: extractionLink.extractionId })
      .from(extractionLink)
      .where(and(eq(extractionLink.entityType, source.entityType), eq(extractionLink.entityId, source.entityId)))
      .all(),
  );
  const ids = [...new Set(pairs.map(pair => pair.extractionId))];
  return ids.length ? db.select().from(extraction).where(inArray(extraction.id, ids)).all() : [];
}

export function workspaceExists(id: string) {
  return Boolean(db.select({ id: collaborationWorkspace.id }).from(collaborationWorkspace).where(eq(collaborationWorkspace.id, id)).get());
}
