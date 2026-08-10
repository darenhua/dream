import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { calendarEvent, chainRun, dailyPlan } from "../db/schema";
import { todayLocal } from "../lib/time";
import { getRun, runsForDate } from "./chains";
import { getPlanDoc } from "./planDocs";
import { latestPick } from "./prioritize";
import { activeEra } from "./monthlyPlans";
import { lineageHead } from "./records";
import { currentWeeklyPlanV2 } from "./weeklyPlanV2";

// Daily plan reads (post-demolition, ruling R2): a daily plan is date +
// theme + armed chains, nothing else. Writes go through save_plan
// (dailyPlansV3); this module keeps the read views the oracle, the API, and
// doing mode share. The old context/create tools and the v1-era
// generic-productivity field family are gone — schema included.

/** The active (non-superseded) plan for a date. */
export function activePlanFor(date: string) {
  return db
    .select()
    .from(dailyPlan)
    .where(and(eq(dailyPlan.date, date), isNull(dailyPlan.supersededByPlanId)))
    .orderBy(desc(dailyPlan.createdAt))
    .limit(1)
    .get();
}

export function getDailyPlanV2(id: string) {
  const plan = db.select().from(dailyPlan).where(eq(dailyPlan.id, id)).get();
  if (!plan) return null;
  const runs = db
    .select()
    .from(chainRun)
    .where(and(eq(chainRun.dailyPlanId, id), isNull(chainRun.cancelledAt)))
    .all()
    .map(run => getRun(run.id)!);
  return { ...plan, runs };
}

/** Prior daily plans as PRIORS (themes, choices — how the user plans), never
 * as a completion ledger: no armed/completed counts here, by the no-shame
 * law. Exported for the planning oracle. */
export function recentDailyPlans(limit = 7) {
  return db
    .select()
    .from(dailyPlan)
    .where(isNull(dailyPlan.supersededByPlanId))
    .orderBy(desc(dailyPlan.date))
    .limit(limit)
    .all();
}

function monthTheme() {
  const era = activeEra();
  if (era) return { theme: era.theme, endDate: era.periodEnd, focusId: era.id };
  const pick = latestPick();
  if (!pick) return null;
  const group = lineageHead("experiment_group", pick.groupLineageId) as
    | { theme?: string | null; title?: string | null }
    | undefined;
  return { theme: group?.theme ?? group?.title ?? null, endDate: pick.pick.endDate, focusId: pick.pick.id };
}

/** Doing mode ("ugh I don't wanna do this task"): everything the assistant
 * needs to coach the CURRENT moment — the active cue block and its chain,
 * the day's plan, the week's theme, and the one-pager docs. */
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

  const plan = activePlanFor(date);
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
    plan: plan ? { theme: plan.theme, description: plan.description } : null,
    week: week ? { theme: week.theme } : null,
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
