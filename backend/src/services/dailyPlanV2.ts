import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { calendarEvent, chainRun, dailyPlan, experimentGroup, task } from "../db/schema";
import { todayLocal } from "../lib/time";
import { armChain, getRun, runsForDate } from "./chains";
import { emit } from "./events";
import { getPlanDoc } from "./planDocs";
import { latestPick } from "./prioritize";
import { currentWeeklyPlanV2 } from "./weeklyPlanV2";
import { unreviewedDays, winsForDate } from "./wins";

// Daily plan v2 (PLANNING_REVAMP_SPEC §4.2): a ≤5-minute conversation that is
// SELECTION, not creation — theme, top priority, 2–3 chains off the weekly
// list, first domino, minimum viable day. Direct write, like v1: the
// conversation's confirmation is the review. Chains replace items entirely;
// old plans keep their dormant daily_plan_item rows.

export const DailyPlanV2InputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    theme: z.string().trim().min(1).max(300), // held in mind for micro-decisions
    // reported state (energy / social / work) — tomorrow's planner reads it
    description: z.string().trim().min(1).max(50_000),
    topPriority: z.string().trim().min(1).max(500),
    supportingHealth: z.string().trim().max(500).optional(),
    supportingConnection: z.string().trim().max(500).optional(),
    firstDomino: z.string().trim().min(1).max(500), // the smallest starting action
    minimumViableDay: z.string().trim().min(1).max(1_000), // still counts as a win
    parkingLot: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
    selectedChains: z
      .array(
        z
          .object({
            chainLineageId: z.string().min(1),
            startAt: z.string().datetime().optional(),
            endAt: z.string().datetime().optional(),
          })
          .strict()
          .refine(c => Boolean(c.startAt) === Boolean(c.endAt), "startAt and endAt come together"),
      )
      .max(3), // 2–3 chain blocks a day is the contract; the cap is hard
  })
  .strict();
export type DailyPlanV2Input = z.infer<typeof DailyPlanV2InputSchema>;

/** Direct write: plan row + armed chain runs (+ their cue blocks). */
export function createDailyPlanV2(raw: unknown) {
  const input = DailyPlanV2InputSchema.parse(raw);
  const existing = db.select().from(dailyPlan).where(eq(dailyPlan.date, input.date)).get();
  if (existing) throw new Error(`a daily plan for ${input.date} already exists`);
  const week = currentWeeklyPlanV2(input.date);

  const planId = db.transaction(() => {
    const plan = db
      .insert(dailyPlan)
      .values({
        weeklyPlanId: week?.id ?? null,
        date: input.date,
        theme: input.theme,
        description: input.description,
        topPriority: input.topPriority,
        supportingHealth: input.supportingHealth ?? null,
        supportingConnection: input.supportingConnection ?? null,
        firstDomino: input.firstDomino,
        minimumViableDay: input.minimumViableDay,
        parkingLotJson: JSON.stringify(input.parkingLot),
      })
      .returning()
      .get();
    for (const selected of input.selectedChains) {
      armChain(selected.chainLineageId, {
        date: input.date,
        dailyPlanId: plan.id,
        startAt: selected.startAt,
        endAt: selected.endAt,
        dayTheme: input.theme,
      });
    }
    return plan.id;
  });

  emit("daily_plan", planId, "daily_plan_v2_created", { date: input.date });
  return getDailyPlanV2(planId)!;
}

export function getDailyPlanV2(id: string) {
  const plan = db.select().from(dailyPlan).where(eq(dailyPlan.id, id)).get();
  if (!plan) return null;
  const runs = db
    .select()
    .from(chainRun)
    .where(eq(chainRun.dailyPlanId, id))
    .all()
    .map(run => getRun(run.id)!);
  return {
    ...plan,
    parkingLot: plan.parkingLotJson ? (JSON.parse(plan.parkingLotJson) as string[]) : [],
    runs,
  };
}

function recentDailyPlans(limit = 7) {
  return db
    .select()
    .from(dailyPlan)
    .orderBy(desc(dailyPlan.date))
    .limit(limit)
    .all()
    .map(plan => {
      const runs = db.select().from(chainRun).where(eq(chainRun.dailyPlanId, plan.id)).all();
      return {
        ...plan,
        parkingLot: plan.parkingLotJson ? (JSON.parse(plan.parkingLotJson) as string[]) : [],
        runsArmed: runs.length,
        runsCompleted: runs.filter(r => r.completedAt != null).length,
      };
    });
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthTheme() {
  const pick = latestPick();
  if (!pick) return null;
  const group = db.select().from(experimentGroup).where(eq(experimentGroup.id, pick.pick.experimentGroupId)).get();
  return { theme: group?.theme ?? group?.title ?? null, endDate: pick.pick.endDate, focusId: pick.pick.id };
}

/** The ≤5-minute conversation's context. REVIEW FIRST: yesterday's evidence
 * opens the session (and any unreviewed days get a quick compile) — then the
 * plan is pure selection from the weekly pre-built lists. */
export function dailyPlanContextV2(forDate?: string) {
  const date = forDate ?? todayLocal();
  const yesterday = addDays(date, -1);
  const week = currentWeeklyPlanV2(date);
  return {
    date,
    reviewFirst: {
      yesterday,
      yesterdayWins: winsForDate(yesterday),
      unreviewedDays: unreviewedDays(),
    },
    month: monthTheme(),
    week: week
      ? {
          id: week.id,
          weekOf: week.weekOf,
          direction: week.direction,
          theme: week.theme,
          topOutcomes: week.topOutcomes,
          fearToFace: week.fearToFace,
          failurePoints: week.failurePoints,
          successDefinition: week.successDefinition,
          candidateMissions: week.candidateMissions,
          // the menu: pick 2–3 of these, don't invent new ones mid-week
          armedChains: week.chains,
        }
      : null,
    recentDailyPlans: recentDailyPlans(7),
    openTasks: db
      .select()
      .from(task)
      .where(and(isNull(task.doneAt), isNull(task.droppedAt)))
      .all()
      .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, deadlineDate: row.deadlineDate, description: row.description })),
    calendarNote:
      "Read the LIVE day via the user's Google Calendar MCP before proposing cue times; Dream's rows are pending write jobs, never the calendar. The gcal MCP is READ-ONLY: all calendar writes happen through Dream.",
  };
}

/** Doing mode ("ugh I don't wanna do this task"): everything the assistant
 * needs to coach the CURRENT moment — the active cue block and its chain,
 * the day's plan, the week's direction, and the one-pager docs. */
export function currentTaskContext() {
  const date = todayLocal();
  const now = Date.now();
  const runs = runsForDate(date);
  const withEvents = runs
    .map(run => ({
      run,
      event: run.calendarEventId
        ? db.select().from(calendarEvent).where(eq(calendarEvent.id, run.calendarEventId)).get()
        : undefined,
    }))
    .filter(x => x.event);
  const active = withEvents
    .filter(x => !x.run.completedAt && Date.parse(x.event!.startAt) <= now && now < Date.parse(x.event!.endAt))
    .sort((a, b) => Date.parse(a.event!.startAt) - Date.parse(b.event!.startAt))[0];
  const upcoming = withEvents
    .filter(x => !x.run.completedAt && Date.parse(x.event!.startAt) > now)
    .sort((a, b) => Date.parse(a.event!.startAt) - Date.parse(b.event!.startAt))[0];

  const plan = db.select().from(dailyPlan).where(eq(dailyPlan.date, date)).get();
  const week = currentWeeklyPlanV2(date);
  const month = monthTheme();

  return {
    date,
    now: new Date(now).toISOString(),
    currentBlock: active
      ? {
          title: active.event!.title,
          startAt: active.event!.startAt,
          endAt: active.event!.endAt,
          run: getRun(active.run.id),
        }
      : null,
    nextBlock: upcoming
      ? { title: upcoming.event!.title, startAt: upcoming.event!.startAt, runId: upcoming.run.id }
      : null,
    todaysRuns: runs.map(r => ({
      id: r.id,
      trigger: r.chain?.trigger ?? null,
      completedAt: r.completedAt,
      stepsDone: r.steps.filter(s => s.doneAt).length,
      stepsTotal: r.steps.length,
    })),
    plan: plan
      ? {
          theme: plan.theme,
          topPriority: plan.topPriority,
          firstDomino: plan.firstDomino,
          minimumViableDay: plan.minimumViableDay,
          description: plan.description,
        }
      : null,
    week: week
      ? { direction: week.direction, theme: week.theme, fearToFace: week.fearToFace, successDefinition: week.successDefinition }
      : null,
    month,
    docs: {
      daily: plan ? (getPlanDoc("daily", plan.id)?.contentMd ?? null) : null,
      weekly: week ? (getPlanDoc("weekly", week.id)?.contentMd ?? null) : null,
      monthly: month ? (getPlanDoc("monthly", month.focusId)?.contentMd ?? null) : null,
    },
    calendarNote:
      "For anything beyond these blocks (meetings, real events), read the user's LIVE Google Calendar via their gcal MCP — read-only.",
  };
}
