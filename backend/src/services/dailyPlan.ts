import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { calendarEvent, dailyPlan, dailyPlanItem, experiment, leisureActivity, task } from "../db/schema";
import { todayLocal } from "../lib/time";
import { createScheduledEvents, pushPendingEvents } from "./calendarWriter";
import { getConfig } from "./config";
import { emit } from "./events";
import { currentPick } from "./prioritize";
import { weeklyPlanItems } from "./weeklyPlan";

// Daily plans (Phase 7). The daily conversation's confirmation IS the review
// (spec §8a): create_daily_plan writes directly — plan row, items, and
// scheduled events — with no inbox stop. No statuses anywhere: expiry derives
// from the date, completion from the manual dashboard done-toggles (which
// double as the habit signal), and the next day reads the reported state
// stored in the plan's description.

export const DailyPlanInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    theme: z.string().trim().min(1).max(300), // the work-centric one-liner
    // reported state (energy / social / work answers) + the day's intent —
    // tomorrow's planner reads this
    description: z.string().trim().min(1).max(50_000),
    items: z
      .array(
        z.object({
          kind: z.enum(["block", "todo", "leisure"]),
          text: z.string().trim().min(1).max(2_000),
          startAt: z.string().datetime().optional(),
          endAt: z.string().datetime().optional(),
          taskLineageId: z.string().optional(),
        }),
      )
      .max(60)
      .default([]),
  })
  .strict();
export type DailyPlanInput = z.infer<typeof DailyPlanInputSchema>;

/** Direct write: the conversation already confirmed the plan. */
export function createDailyPlan(raw: unknown) {
  const input = DailyPlanInputSchema.parse(raw);
  const existing = db.select().from(dailyPlan).where(eq(dailyPlan.date, input.date)).get();
  if (existing) throw new Error(`a daily plan for ${input.date} already exists`);
  const pick = currentPick();
  const week = pick
    ? db
        .select()
        .from(experiment)
        .where(and(eq(experiment.currentFocusId, pick.pick.id), lte(experiment.weekOf, input.date)))
        .orderBy(desc(experiment.weekOf))
        .limit(1)
        .get()
    : undefined;

  const plan = db
    .insert(dailyPlan)
    .values({ weeklyPlanId: week?.id ?? null, date: input.date, theme: input.theme, description: input.description })
    .returning()
    .get();

  for (const item of input.items) {
    let calendarEventId: string | null = null;
    if (item.startAt && item.endAt) {
      const [id] = createScheduledEvents([
        {
          entityType: item.kind === "leisure" ? "leisure" : item.taskLineageId ? "task" : "daily_adhoc",
          entityId: item.taskLineageId ?? plan.id,
          title: item.text,
          startAt: item.startAt,
          endAt: item.endAt,
          blockStyle: "task",
        },
      ]);
      calendarEventId = id ?? null;
    }
    db.insert(dailyPlanItem)
      .values({
        dailyPlanId: plan.id,
        kind: item.kind,
        text: item.text,
        calendarEventId,
        taskLineageId: item.taskLineageId ?? null,
      })
      .run();
  }

  emit("daily_plan", plan.id, "daily_plan_created", { date: input.date });
  // best-effort push; a plan never blocks on Google
  void pushPendingEvents().catch(() => {});
  return getDailyPlan(plan.id)!;
}

export function getDailyPlan(id: string) {
  const plan = db.select().from(dailyPlan).where(eq(dailyPlan.id, id)).get();
  if (!plan) return null;
  const items = db.select().from(dailyPlanItem).where(eq(dailyPlanItem.dailyPlanId, id)).all();
  return { ...plan, items };
}

export function listDailyPlans(limit = 7) {
  return db
    .select()
    .from(dailyPlan)
    .orderBy(desc(dailyPlan.date))
    .limit(limit)
    .all()
    .map(plan => ({
      ...plan,
      items: db.select().from(dailyPlanItem).where(eq(dailyPlanItem.dailyPlanId, plan.id)).all(),
    }));
}

export function toggleDailyItem(itemId: string, done: boolean) {
  const row = db
    .update(dailyPlanItem)
    .set({ doneAt: done ? new Date().toISOString() : null })
    .where(eq(dailyPlanItem.id, itemId))
    .returning()
    .get();
  // completing a scheduled block also stamps its event (habit signal)
  if (row?.calendarEventId) {
    db.update(calendarEvent)
      .set({ completedAt: done ? new Date().toISOString() : null })
      .where(eq(calendarEvent.id, row.calendarEventId))
      .run();
  }
  return row;
}

/** The daily conversation's context (windowed per spec §7): the CURRENT
 * weekly plan only, the last ~7 daily plans with completions and reported
 * state, open deadline tasks (the daily nag), leisure, the standing work
 * context, and the date's already-scheduled events. */
export function dailyPlanContext(forDate?: string) {
  const date = forDate ?? todayLocal();
  const pick = currentPick();
  const week = pick
    ? db
        .select()
        .from(experiment)
        .where(and(eq(experiment.currentFocusId, pick.pick.id), lte(experiment.weekOf, date)))
        .orderBy(desc(experiment.weekOf))
        .limit(1)
        .get()
    : undefined;

  const openTasks = db
    .select()
    .from(task)
    .where(and(isNull(task.doneAt), isNull(task.droppedAt)))
    .all()
    .map(row => ({
      lineageId: row.lineageId ?? row.id,
      title: row.title,
      deadlineDate: row.deadlineDate,
      description: row.description,
      // unanchored deadline tasks are the DAILY NAG: ask every day until scheduled
      anchored: Boolean(
        db.select({ id: calendarEvent.id }).from(calendarEvent).where(eq(calendarEvent.entityId, row.lineageId ?? row.id)).get(),
      ),
    }));

  const scheduled = db
    .select()
    .from(calendarEvent)
    .where(and(gte(calendarEvent.startAt, `${date}T00:00:00`), lte(calendarEvent.startAt, `${date}T23:59:59.999Z`)))
    .all()
    .map(row => ({ title: row.title, startAt: row.startAt, endAt: row.endAt, entityType: row.entityType, completedAt: row.completedAt }));

  return {
    date,
    pick: pick ? { endDate: pick.pick.endDate, groupLineageId: pick.groupLineageId } : null,
    currentWeek: week
      ? {
          id: week.id,
          weekOf: week.weekOf,
          theme: week.theme ?? week.title,
          description: week.description,
          items: weeklyPlanItems(week.id).map(item => ({ id: item.id, kind: item.kind, text: item.title, doneAt: item.doneAt })),
        }
      : null,
    recentDailyPlans: listDailyPlans(7),
    openTasks,
    leisure: db
      .select()
      .from(leisureActivity)
      .all()
      .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, description: row.description, fitsWhen: row.fitsWhen })),
    workContext: getConfig<string>("WORK_CONTEXT") ?? "",
    scheduledOnDate: scheduled,
  };
}
