import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { winEntry } from "../src/db/schema";
import { app } from "../src/api/app";
import {
  armChain,
  chainLibrary,
  createChain,
  getRun,
  markMinimumRun,
  reviseChain,
  setChainStatus,
  toggleRunStep,
} from "../src/services/chains";
import { unreviewedDays, winsForDate } from "../src/services/wins";

beforeEach(() => wipeAllTables());

const GROUP = "group-lineage-test";

function chainInput(overrides: Record<string, unknown> = {}) {
  return {
    experimentGroupLineageId: GROUP,
    trigger: "I finish breakfast",
    purpose: "start the workday without a decision",
    minimumVersion: "open the laptop and read the task title",
    rewardKind: "playlist",
    rewardText: "the good playlist",
    steps: [
      { kind: "starter", text: "tie my shoelaces" },
      { kind: "warmup", text: "fill the water bottle" },
      { kind: "core", text: "open the current work task" },
      { kind: "core", text: "work the first pomodoro" },
      { kind: "reward", text: "playlist on" },
    ],
    ...overrides,
  };
}

describe("chain lifecycle", () => {
  test("canonical shape is enforced", () => {
    expect(() =>
      createChain(chainInput({ steps: [{ kind: "core", text: "just work" }, { kind: "core", text: "more" }, { kind: "reward", text: "walk" }] })),
    ).toThrow(/starter/);
    expect(() =>
      createChain(
        chainInput({
          steps: [
            { kind: "starter", text: "tie shoelaces" },
            { kind: "core", text: "work" },
            { kind: "warmup", text: "late warmup" },
            { kind: "reward", text: "walk" },
          ],
        }),
      ),
    ).toThrow(/warmup/);
  });

  test("active cap rejects the 6th chain", () => {
    for (let i = 0; i < 5; i++) createChain(chainInput({ trigger: `cue ${i}` }));
    expect(() => createChain(chainInput({ trigger: "one too many" }))).toThrow(/active chains/);
    // draft is fine; activating it later is not
    const draft = createChain(chainInput({ trigger: "parked", status: "draft" }));
    expect(() => setChainStatus(draft.lineageId!, "active")).toThrow(/active chains/);
    // retiring one frees a slot
    const first = chainLibrary(GROUP).find(c => c.trigger === "cue 0")!;
    setChainStatus(first.lineageId!, "retired");
    expect(setChainStatus(draft.lineageId!, "active").status).toBe("active");
  });

  test("arm → snapshot → toggle → auto win; snapshot survives revision", () => {
    const chain = createChain(chainInput());
    const run = armChain(chain.lineageId!, {
      date: "2026-07-31",
      startAt: "2026-07-31T13:00:00.000Z",
      endAt: "2026-07-31T14:00:00.000Z",
      dayTheme: "be a kind person",
    });
    expect(run.steps).toHaveLength(5);
    expect(run.calendarEventId).toBeTruthy();

    // revising the chain must not touch the armed snapshot
    reviseChain(chain.lineageId!, chainInput({ steps: chainInput().steps.slice(0, 3).concat([{ kind: "reward", text: "diet coke" }]) }) as never);
    expect(getRun(run.id)!.steps).toHaveLength(5);

    for (const step of run.steps) toggleRunStep(run.id, step.id, true);
    const done = getRun(run.id)!;
    expect(done.completedAt).toBeTruthy();
    expect(done.minimumOnly).toBe(0);
    const wins = winsForDate("2026-07-31");
    expect(wins.entries.filter(e => e.source === "auto")).toHaveLength(1);
    expect(wins.runs.completed).toBe(1);

    // un-toggling reopens and withdraws the auto win (evidence must be true)
    toggleRunStep(run.id, done.steps[0]!.id, false);
    expect(getRun(run.id)!.completedAt).toBeNull();
    expect(db.select().from(winEntry).where(eq(winEntry.source, "auto")).all()).toHaveLength(0);
  });

  test("ad-hoc run (no dailyPlanId) + minimum version still counts", () => {
    const chain = createChain(chainInput());
    const run = armChain(chain.lineageId!, { date: "2026-07-30" });
    expect(run.dailyPlanId).toBeNull();
    const done = markMinimumRun(run.id);
    expect(done!.completedAt).toBeTruthy();
    expect(done!.minimumOnly).toBe(1);
    const wins = winsForDate("2026-07-30");
    expect(wins.entries[0]!.text).toContain("still counts");
    // completed but never conversationally reviewed → surfaces as unreviewed
    expect(unreviewedDays()).toContain("2026-07-30");
  });
});

describe("plans API", () => {
  test("/api/plans/now answers idle with no data", async () => {
    const res = await app.request("/api/plans/now");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; winsToday: number };
    expect(body.mode).toBe("idle");
    expect(body.winsToday).toBe(0);
  });

  test("step toggle route validates run/step pairing", async () => {
    const chain = createChain(chainInput());
    const run = armChain(chain.lineageId!, { date: todayStr() });
    const res = await app.request(`/api/plans/runs/${run.id}/steps/not-a-step/toggle`, {
      method: "POST",
      body: JSON.stringify({ done: true }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    const ok = await app.request(`/api/plans/runs/${run.id}/steps/${run.steps[0]!.id}/toggle`, {
      method: "POST",
      body: JSON.stringify({ done: true }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
  });
});

function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}
