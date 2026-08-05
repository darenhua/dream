import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { calendarEvent, dailyPlan, experimentGroup, planDoc, weeklyPlan, weeklyPlanChain } from "../../db/schema";
import { todayLocal } from "../../lib/time";
import { armChain, chainHead, getRun, markMinimumRun, runsForDate, toggleRunStep } from "../../services/chains";
import { latestPick } from "../../services/prioritize";
import { activeEra } from "../../services/monthlyPlans";
import { unreviewedDays, winsForDate, winsForFocus, winsForWeek } from "../../services/wins";

// The new dashboard's API (PLANNING_REVAMP_SPEC §7). The now-screen never
// shows a wall of todos: inside a cue block it walks ONE chain step at a
// time; outside one it shows the theme, the next cue, and the minimum viable
// day. Glanceability contract: full themes/descriptions, always.

export const planRoutes = new Hono();

const fail = (c: Context, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);

function todaysPlan(date: string) {
  const plan = db
    .select()
    .from(dailyPlan)
    .where(and(eq(dailyPlan.date, date), isNull(dailyPlan.supersededByPlanId)))
    .orderBy(desc(dailyPlan.createdAt))
    .limit(1)
    .get();
  if (!plan) return null;
  return plan;
}

function currentWeeklyPlan(date: string) {
  return db
    .select()
    .from(weeklyPlan)
    .where(lte(weeklyPlan.weekOf, date))
    .orderBy(desc(weeklyPlan.weekOf), desc(weeklyPlan.createdAt))
    .limit(1)
    .get();
}

function monthTheme(): { theme: string | null; endDate: string | null } | null {
  const era = activeEra();
  if (era) return { theme: era.theme, endDate: era.periodEnd };
  const pick = latestPick();
  if (!pick) return null;
  const group = db.select().from(experimentGroup).where(eq(experimentGroup.id, pick.pick.experimentGroupId)).get();
  return { theme: group?.theme ?? group?.title ?? null, endDate: pick.pick.endDate };
}

/** The now-screen payload: what block am I in, what is the ONE next step. */
planRoutes.get("/now", c => {
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

  const plan = todaysPlan(date);
  const week = currentWeeklyPlan(date);
  const base = {
    date,
    theme: plan?.theme ?? null,
    weekDirection: week?.direction ?? week?.theme ?? null,
    month: monthTheme(),
    winsToday: winsForDate(date).entries.length,
    runsToday: runs.map(r => ({
      id: r.id,
      trigger: r.chain?.trigger ?? null,
      completedAt: r.completedAt,
      minimumOnly: r.minimumOnly,
      stepsDone: r.steps.filter(s => s.doneAt).length,
      stepsTotal: r.steps.length,
    })),
  };

  const active = withEvents
    .filter(
      x =>
        !x.run.completedAt && Date.parse(x.event!.startAt) <= now && now < Date.parse(x.event!.endAt),
    )
    .sort((a, b) => Date.parse(a.event!.startAt) - Date.parse(b.event!.startAt))[0];
  if (active) {
    const run = getRun(active.run.id)!;
    const currentStep = run.steps.find(s => !s.doneAt) ?? null;
    return c.json({
      mode: "chain",
      ...base,
      block: { title: active.event!.title, startAt: active.event!.startAt, endAt: active.event!.endAt },
      run: {
        id: run.id,
        trigger: run.chain?.trigger,
        purpose: run.chain?.purpose,
        minimumVersion: run.chain?.minimumVersion,
        reward: run.chain?.rewardText ?? run.chain?.rewardKind,
        steps: run.steps,
        currentStepId: currentStep?.id ?? null,
      },
    });
  }

  const upcoming = withEvents
    .filter(x => !x.run.completedAt && Date.parse(x.event!.startAt) > now)
    .sort((a, b) => Date.parse(a.event!.startAt) - Date.parse(b.event!.startAt))[0];
  return c.json({
    mode: "idle",
    ...base,
    nextCue: upcoming
      ? {
          runId: upcoming.run.id,
          title: upcoming.event!.title,
          startAt: upcoming.event!.startAt,
          minutesUntil: Math.max(0, Math.round((Date.parse(upcoming.event!.startAt) - now) / 60_000)),
        }
      : null,
  });
});

/** Glanceable day: full plan + runs + today's win ledger. */
planRoutes.get("/today", c => {
  const date = c.req.query("date") ?? todayLocal();
  return c.json({
    date,
    plan: todaysPlan(date),
    runs: runsForDate(date),
    wins: winsForDate(date),
    unreviewedDays: unreviewedDays(),
  });
});

/** Glanceable week: the thick weekly plan + its chain set + per-day pulse. */
planRoutes.get("/week", c => {
  const date = c.req.query("date") ?? todayLocal();
  const week = currentWeeklyPlan(date);
  if (!week) return c.json({ week: null, month: monthTheme() });
  const chains = db
    .select()
    .from(weeklyPlanChain)
    .where(eq(weeklyPlanChain.weeklyPlanId, week.id))
    .all()
    .map(link => {
      const head = chainHead(link.chainLineageId);
      return head ? { lineageId: link.chainLineageId, trigger: head.trigger, status: head.status } : null;
    })
    .filter(Boolean);
  return c.json({
    week: {
      ...week,
      topOutcomes: week.topOutcomesJson ? JSON.parse(week.topOutcomesJson) : [],
      milestones: week.milestonesJson ? JSON.parse(week.milestonesJson) : [],
      failurePoints: week.failurePointsJson ? JSON.parse(week.failurePointsJson) : [],
      candidateMissions: week.candidateMissionsJson ? JSON.parse(week.candidateMissionsJson) : [],
    },
    chains,
    wins: winsForWeek(week.weekOf),
    month: monthTheme(),
  });
});

const ToggleSchema = z.object({ done: z.boolean() }).strict();
planRoutes.post("/runs/:runId/steps/:stepId/toggle", async c => {
  try {
    const body = ToggleSchema.parse(await c.req.json());
    return c.json(toggleRunStep(c.req.param("runId"), c.req.param("stepId"), body.done));
  } catch (e) {
    return fail(c, e);
  }
});

planRoutes.post("/runs/:runId/minimum", c => {
  try {
    return c.json(markMinimumRun(c.req.param("runId")));
  } catch (e) {
    return fail(c, e);
  }
});

// Surplus capacity: arm an extra chain right now. No formal plan object —
// the run itself (and its win) is the only record, by design (spec §8.6).
const AdhocSchema = z
  .object({
    chainLineageId: z.string().min(1),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
  })
  .strict();
planRoutes.post("/runs/adhoc", async c => {
  try {
    const body = AdhocSchema.parse(await c.req.json());
    return c.json(
      armChain(body.chainLineageId, { date: todayLocal(), startAt: body.startAt, endAt: body.endAt }),
    );
  } catch (e) {
    return fail(c, e);
  }
});

planRoutes.get("/wins", c => {
  const scope = c.req.query("scope") ?? "day";
  try {
    if (scope === "day") return c.json(winsForDate(c.req.query("date") ?? todayLocal()));
    if (scope === "week") {
      const weekOf = c.req.query("weekOf") ?? currentWeeklyPlan(todayLocal())?.weekOf;
      if (!weekOf) return c.json({ error: "no weekOf given and no weekly plan exists" }, 400);
      return c.json(winsForWeek(weekOf));
    }
    if (scope === "month") return c.json(winsForFocus(c.req.query("focusId") ?? undefined));
    return c.json({ error: `unknown scope ${scope}` }, 400);
  } catch (e) {
    return fail(c, e);
  }
});

// Parking lot: save the distraction without acting on it.
// One-pagers: living context per horizon; docs accrete, plans stay stable.
planRoutes.get("/docs/:scope/:refId", c => {
  const scope = c.req.param("scope");
  if (!["daily", "weekly", "monthly"].includes(scope)) return c.json({ error: `bad scope ${scope}` }, 400);
  const doc = db
    .select()
    .from(planDoc)
    .where(and(eq(planDoc.scope, scope as "daily" | "weekly" | "monthly"), eq(planDoc.refId, c.req.param("refId"))))
    .get();
  return c.json({ doc: doc ?? null });
});

const DocSchema = z.object({ contentMd: z.string().min(1).max(200_000) }).strict();
planRoutes.put("/docs/:scope/:refId", async c => {
  try {
    const scope = c.req.param("scope");
    if (!["daily", "weekly", "monthly"].includes(scope)) return c.json({ error: `bad scope ${scope}` }, 400);
    const body = DocSchema.parse(await c.req.json());
    const refId = c.req.param("refId");
    const existing = db
      .select()
      .from(planDoc)
      .where(and(eq(planDoc.scope, scope as "daily" | "weekly" | "monthly"), eq(planDoc.refId, refId)))
      .get();
    if (existing) {
      db.update(planDoc).set({ contentMd: body.contentMd }).where(eq(planDoc.id, existing.id)).run();
      return c.json({ doc: { ...existing, contentMd: body.contentMd } });
    }
    const doc = db
      .insert(planDoc)
      .values({ scope: scope as "daily" | "weekly" | "monthly", refId, contentMd: body.contentMd })
      .returning()
      .get();
    return c.json({ doc });
  } catch (e) {
    return fail(c, e);
  }
});
