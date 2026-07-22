import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { experiment, experimentTask, groupIdea, habit, leisureActivity, task } from "../db/schema";
import { createScheduledEvents } from "./calendarWriter";
import { todayLocal } from "../lib/time";
import { currentPick } from "./prioritize";
import { readRecord } from "./recordReads";
import { emit } from "./events";

// Weekly plans (Phase 6): the legacy `experiment` table slimmed into the
// weekly record — no statuses, no review verdicts. A weekly belongs to a
// specific pick (current_focus_id); the next week reads its predecessors and
// the completion data instead of any success/failure judgment. Weekly
// scheduling is MINIMAL: habit blocks being established + must-anchor blocks;
// everything else is noted as items (todo|intention) for the daily planner.

export const WeeklyPlanOpSchema = z
  .object({
    op: z.literal("create_weekly_plan"),
    weekOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(value => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1, "weekOf must be a Monday"),
    theme: z.string().trim().min(1).max(300),
    // the weekly goal + the user's reported state (capacity, fear level…) —
    // successor plans read this
    description: z.string().trim().min(1).max(50_000),
    items: z
      .array(z.object({ kind: z.enum(["todo", "intention"]), text: z.string().trim().min(1).max(2_000) }))
      .max(50)
      .default([]),
    // habits being ESTABLISHED this week (system origin, born now — the
    // materialization boundary). Times are explicit ISO strings: the agent
    // owns timezone math, the server owns none.
    habitStarts: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(300),
          description: z.string().trim().max(10_000).optional(),
          rrule: z.string().trim().max(1_000),
          firstStartAt: z.string().datetime(),
          firstEndAt: z.string().datetime(),
        }),
      )
      .max(10)
      .default([]),
    // must-anchor blocks: existing deadline tasks or standing weekly blocks
    anchoredEvents: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(300),
          startAt: z.string().datetime(),
          endAt: z.string().datetime(),
          taskLineageId: z.string().optional(),
        }),
      )
      .max(20)
      .default([]),
    ideasDone: z.array(z.string()).max(50).default([]), // group_idea membership done-marks confirmed in conversation
  })
  .strict();
export type WeeklyPlanOp = z.infer<typeof WeeklyPlanOpSchema>;

/** Applies inside the change-set transaction. */
export function applyWeeklyPlan(op: WeeklyPlanOp, changeSetId: string): string {
  const pick = currentPick();
  if (!pick) throw new Error("no current pick — run prioritize before planning a week");
  const duplicate = db
    .select({ id: experiment.id })
    .from(experiment)
    .where(and(eq(experiment.currentFocusId, pick.pick.id), eq(experiment.weekOf, op.weekOf)))
    .get();
  if (duplicate) throw new Error(`a weekly plan for ${op.weekOf} already exists in this pick`);

  const row = db
    .insert(experiment)
    .values({
      title: op.theme,
      kind: "actionable",
      experimentGroupId: pick.pick.experimentGroupId,
      currentFocusId: pick.pick.id,
      weekOf: op.weekOf,
      theme: op.theme,
      description: op.description,
      status: "running", // legacy column, unused; kept non-misleading
      startedAt: new Date().toISOString(),
    })
    .returning()
    .get();

  for (const item of op.items) {
    db.insert(experimentTask)
      .values({ experimentId: row.id, kind: item.kind as never, title: item.text, scheduleMode: "none" })
      .run();
  }

  for (const start of op.habitStarts) {
    const habitId = crypto.randomUUID();
    db.insert(habit)
      .values({
        id: habitId,
        lineageId: habitId,
        version: 1,
        title: start.title,
        description: start.description ?? null,
        origin: "system",
        status: "building",
        currentFocusId: pick.pick.id,
      })
      .run();
    createScheduledEvents([
      {
        entityType: "habit",
        entityId: habitId,
        title: start.title,
        startAt: start.firstStartAt,
        endAt: start.firstEndAt,
        rrule: start.rrule,
        blockStyle: "experiment",
      },
    ]);
  }

  for (const block of op.anchoredEvents) {
    createScheduledEvents([
      {
        entityType: block.taskLineageId ? "task" : "weekly_item",
        entityId: block.taskLineageId ?? row.id,
        title: block.title,
        startAt: block.startAt,
        endAt: block.endAt,
        blockStyle: block.taskLineageId ? "task" : "obligation",
      },
    ]);
  }

  const now = new Date().toISOString();
  for (const ideaLineageId of op.ideasDone) {
    db.update(groupIdea)
      .set({ doneAt: now })
      .where(and(eq(groupIdea.groupLineageId, pick.groupLineageId), eq(groupIdea.ideaLineageId, ideaLineageId)))
      .run();
  }

  emit("experiment", row.id, "weekly_plan_created", { changeSetId, weekOf: op.weekOf });
  return row.id;
}

export function weeklyPlanItems(weeklyPlanId: string) {
  return db.select().from(experimentTask).where(eq(experimentTask.experimentId, weeklyPlanId)).orderBy(asc(experimentTask.createdAt)).all();
}

export function listWeeklyPlans(currentFocusId: string) {
  return db
    .select()
    .from(experiment)
    .where(eq(experiment.currentFocusId, currentFocusId))
    .orderBy(desc(experiment.weekOf))
    .all()
    .map(row => ({
      id: row.id,
      weekOf: row.weekOf,
      theme: row.theme ?? row.title,
      description: row.description,
      items: weeklyPlanItems(row.id).map(item => ({ id: item.id, kind: item.kind, text: item.title, doneAt: item.doneAt })),
    }));
}

function weeksBetween(from: string, to: string): number {
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / (7 * 24 * 3600 * 1000)));
}

/** The weekly conversation's context: pick + deadline math, the full group
 * read, ALL prior weeklies of this pick with completions, open deadline
 * tasks, and the leisure list. Never patterns, never rant threads. */
export function weeklyPlanContext() {
  const pick = currentPick();
  if (!pick) return { error: "no current pick — run prioritize first", currentPick: null };
  const today = todayLocal();
  const plans = listWeeklyPlans(pick.pick.id);
  const openTasks = db
    .select()
    .from(task)
    .where(and(isNull(task.doneAt), isNull(task.droppedAt)))
    .all()
    .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, deadlineDate: row.deadlineDate, description: row.description }));
  const leisure = db
    .select()
    .from(leisureActivity)
    .all()
    .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, description: row.description, fitsWhen: row.fitsWhen }));
  return {
    today,
    pick: {
      id: pick.pick.id,
      startedAt: pick.pick.startedAt,
      endDate: pick.pick.endDate,
      reasoning: pick.pick.reasoningMd,
      weeksElapsed: weeksBetween(pick.pick.startedAt, today),
      weeksRemaining: pick.pick.endDate ? weeksBetween(today, pick.pick.endDate) : null,
    },
    group: readRecord("experiment_group", pick.groupLineageId),
    weeklyPlans: plans,
    openTasks,
    leisure,
  };
}

export function toggleWeeklyItem(itemId: string, done: boolean) {
  return db
    .update(experimentTask)
    .set({ doneAt: done ? new Date().toISOString() : null })
    .where(eq(experimentTask.id, itemId))
    .returning()
    .get();
}

export function toggleGroupIdeaDone(groupIdeaId: string, done: boolean) {
  return db
    .update(groupIdea)
    .set({ doneAt: done ? new Date().toISOString() : null })
    .where(eq(groupIdea.id, groupIdeaId))
    .returning()
    .get();
}
