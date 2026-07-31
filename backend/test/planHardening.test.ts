import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { calendarEvent, chainRun, dailyPlan } from "../src/db/schema";
import { toggleRunStep } from "../src/services/chains";
import { createDailyPlanV2, dailyPlanContextV2, getDailyPlanV2 } from "../src/services/dailyPlanV2";
import { applyRecordChangeSet, createRecordChangeSet } from "../src/services/recordChangeSets";
import { createWeeklyPlanV2 } from "../src/services/weeklyPlanV2";
import { winsForDate } from "../src/services/wins";

beforeEach(() => wipeAllTables());

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function currentMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString("en-CA");
}

function bootstrap(): string {
  const cs = createRecordChangeSet({
    summaryMd: "group + pick",
    operations: [
      { op: "create", tempId: "group", model: "experiment_group", role: "central", fields: { title: "raw by saturday", theme: "ship the want" } },
      { op: "pick", group: "temp:group", endDate: futureDate(56), reasoning: "ship it" },
    ],
  });
  expect(applyRecordChangeSet(cs.id).ok).toBe(true);
  const weekly = createWeeklyPlanV2({
    weekOf: currentMonday(),
    direction: "prep only",
    theme: "seal the gate",
    topOutcomes: ["a proven set"],
    description: "scattered capacity",
    chainOps: [
      {
        op: "create",
        tempId: "practice",
        chain: {
          trigger: "I finish breakfast",
          steps: [
            { kind: "starter", text: "put on headphones" },
            { kind: "core", text: "drill the chain" },
            { kind: "reward", text: "diet coke" },
          ],
        },
      },
    ],
    armedChains: ["temp:practice"],
  });
  return (weekly.chains[0] as { lineageId: string }).lineageId;
}

function planInput(chainLineageId: string, overrides: Record<string, unknown> = {}) {
  const today = new Date().toLocaleDateString("en-CA");
  return {
    date: today,
    theme: "ship the want",
    description: "energy mid",
    topPriority: "one verified rep",
    firstDomino: "put on headphones",
    minimumViableDay: "one song",
    selectedChains: [
      {
        chainLineageId,
        startAt: new Date(Date.now() + 3600_000).toISOString(),
        endAt: new Date(Date.now() + 7200_000).toISOString(),
      },
    ],
    ...overrides,
  };
}

describe("phase 6 hardening", () => {
  test("draftKey makes create idempotent", () => {
    const chain = bootstrap();
    const input = planInput(chain, { draftKey: "session-abc-123" });
    const first = createDailyPlanV2(input);
    const second = createDailyPlanV2(input);
    expect(second.id).toBe(first.id);
    expect(db.select().from(dailyPlan).all()).toHaveLength(1);
  });

  test("duplicate without revises fails, naming the existing plan", () => {
    const chain = bootstrap();
    const first = createDailyPlanV2(planInput(chain, { draftKey: "k-11111111" }));
    expect(() => createDailyPlanV2(planInput(chain, { draftKey: "k-22222222" }))).toThrow(first.id);
  });

  test("supersede keeps history, preserves progressed runs, cancels unstarted ones", () => {
    const chain = bootstrap();
    const first = createDailyPlanV2(planInput(chain, { draftKey: "k-11111111" }));
    // give the first plan's run real progress — it must survive the revise
    const run = first.runs[0]!;
    toggleRunStep(run.id, run.steps[0]!.id, true);

    const second = createDailyPlanV2(
      planInput(chain, { draftKey: "k-22222222", revises: first.id, theme: "lighter day" }),
    );
    expect(second.id).not.toBe(first.id);

    const oldRow = db.select().from(dailyPlan).where(eq(dailyPlan.id, first.id)).get()!;
    expect(oldRow.supersededByPlanId).toBe(second.id);

    // progressed run survives, still attached to the old plan
    const oldRun = db.select().from(chainRun).where(eq(chainRun.id, run.id)).get()!;
    expect(oldRun.cancelledAt).toBeNull();
    expect(oldRun.startedAt).toBeTruthy();
    // the new plan armed its own run
    expect(getDailyPlanV2(second.id)!.runs).toHaveLength(1);
  });

  test("supersede cancels a zero-progress run and its cue block; stats exclude it", () => {
    const chain = bootstrap();
    const today = new Date().toLocaleDateString("en-CA");
    const first = createDailyPlanV2(planInput(chain, { draftKey: "k-11111111" }));
    const untouched = first.runs[0]!;
    const second = createDailyPlanV2(planInput(chain, { draftKey: "k-22222222", revises: first.id }));

    const cancelled = db.select().from(chainRun).where(eq(chainRun.id, untouched.id)).get()!;
    expect(cancelled.cancelledAt).toBeTruthy();
    const block = db.select().from(calendarEvent).where(eq(calendarEvent.id, cancelled.calendarEventId!)).get()!;
    expect(block.status).toBe("cancelled");
    // armed count sees only the new plan's run
    expect(winsForDate(today).runs.armed).toBe(1);
    expect(getDailyPlanV2(second.id)!.runs).toHaveLength(1);
  });

  test("context returns nowLocal, both days' plan state, and the quality bar", () => {
    const chain = bootstrap();
    createDailyPlanV2(planInput(chain, { draftKey: "k-11111111" }));
    const ctx = dailyPlanContextV2();
    expect(ctx.nowLocal.time).toMatch(/^\d{2}:\d{2}$/);
    expect(ctx.nowLocal.timezone).toBeTruthy();
    expect(ctx.planState.today.plan?.theme).toBe("ship the want");
    expect(ctx.planState.tomorrow.plan).toBeNull();
    expect(ctx.qualityBar.plan).toContain("shoelace test");
    expect(ctx.qualityBar.wins).toContain("Undeniable");
  });
});
