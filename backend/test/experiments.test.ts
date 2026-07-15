import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import {
  chatSession,
  experiment,
  experimentTask,
  experimentTaskGoal,
  goal,
  goalEvidence,
  goalHabit,
  habit,
} from "../src/db/schema";
import { seedConfig } from "../src/services/config";
import {
  archiveExperiment,
  cancelScheduling,
  commitPlan,
  currentExperiment,
  endExperiment,
  enqueueExperiment,
  listQueue,
  patchTask,
  pickExperiment,
} from "../src/services/experiments";
import { goalDetail, habitDetail } from "../src/services/entityDetail";
import { attemptCounts } from "../src/services/goals";
import type { SchedulePlanT } from "../src/domain/schemas";

function makeGoal(title = "wake at 6am") {
  return db.insert(goal).values({ title, status: "active", origin: "derived" }).returning().get();
}

function queued(title = "phone out of the bedroom", goalIds: string[] = []) {
  return enqueueExperiment({
    title,
    hypothesisMd: "hypothesis",
    goalIds,
    proposalId: null as unknown as string, // FK is nullable; candidates in tests skip the proposal step
  });
}

const PLAN: SchedulePlanT = {
  hypothesis_md: "removing the phone removes the morning scroll",
  planned_duration_days: 7,
  bandwidth: "normal",
  tasks: [
    { kind: "purchase", title: "buy an alarm clock", start: "2026-07-10T18:00:00Z", end: "2026-07-10T18:30:00Z" },
    { kind: "experience", title: "one phone-free morning walk", start: "2026-07-11T08:00:00Z", end: "2026-07-11T09:00:00Z" },
  ],
  habit_blocks: [
    {
      title: "phone docks in kitchen at 22:00",
      rrule: "FREQ=DAILY",
      preferred_time: "22:00",
      duration_minutes: 5,
      first_occurrence: "2026-07-10T22:00:00Z",
    },
  ],
};

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

describe("experiment FSM", () => {
  test("queued → scheduling → running via pick + commitPlan", () => {
    const exp = queued();
    const picked = pickExperiment(exp.id);
    expect(picked.ok).toBe(true);
    expect(db.select().from(experiment).where(eq(experiment.id, exp.id)).get()!.status).toBe("scheduling");
    // pick opened a chat session
    const session = db.select().from(chatSession).where(eq(chatSession.experimentId, exp.id)).get()!;
    expect(session.status).toBe("open");

    const committed = commitPlan(exp.id, PLAN);
    expect(committed.ok).toBe(true);
    const after = db.select().from(experiment).where(eq(experiment.id, exp.id)).get()!;
    expect(after.status).toBe("running");
    expect(after.startedAt).toBeTruthy();
    expect(after.plannedDurationDays).toBe(7);

    // plan side effects: tasks, building habit, planned experience
    const tasks = db.select().from(experimentTask).where(eq(experimentTask.experimentId, exp.id)).all();
    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => t.status === "scheduled")).toBe(true);
    const h = db.select().from(habit).where(eq(habit.experimentId, exp.id)).get()!;
    expect(h.status).toBe("building");
  });

  test("commitPlan persists goal tags; untagged/invalid tags default to the experiment's goals", () => {
    const music = makeGoal("ship music");
    const career = makeGoal("stop people-pleasing");
    const exp = queued("two-front week", [music.id, career.id]);
    pickExperiment(exp.id);

    const plan: SchedulePlanT = {
      ...PLAN,
      tasks: [
        { kind: "setup", title: "studio session", goal_ids: [music.id], start: "2026-07-10T18:00:00Z", end: "2026-07-10T19:00:00Z" },
        { kind: "experience", title: "salary talk", goal_ids: [career.id, "hallucinated-goal-id"], start: "2026-07-11T10:00:00Z", end: "2026-07-11T10:30:00Z" },
        { kind: "purchase", title: "untagged buy", start: "2026-07-12T10:00:00Z", end: "2026-07-12T10:15:00Z" },
      ],
      habit_blocks: [{ ...PLAN.habit_blocks[0]!, goal_ids: [music.id] }],
    };
    expect(commitPlan(exp.id, plan).ok).toBe(true);

    const tasks = db.select().from(experimentTask).where(eq(experimentTask.experimentId, exp.id)).all();
    const tagsFor = (title: string) =>
      db
        .select({ goalId: experimentTaskGoal.goalId })
        .from(experimentTaskGoal)
        .where(eq(experimentTaskGoal.experimentTaskId, tasks.find(t => t.title === title)!.id))
        .all()
        .map(r => r.goalId)
        .sort();

    expect(tagsFor("studio session")).toEqual([music.id]);
    expect(tagsFor("salary talk")).toEqual([career.id]); // hallucinated id dropped
    expect(tagsFor("untagged buy").sort()).toEqual([music.id, career.id].sort()); // defaults to experiment goals

    // Habit joined the tagged goal's ideal set.
    const h = db.select().from(habit).where(eq(habit.experimentId, exp.id)).get()!;
    const habitGoals = db
      .select({ goalId: goalHabit.goalId })
      .from(goalHabit)
      .where(eq(goalHabit.habitId, h.id))
      .all()
      .map(r => r.goalId);
    expect(habitGoals).toEqual([music.id]);
  });

  test("pick guard: one experiment at a time, including scheduling", () => {
    const a = queued("a");
    const b = queued("b");
    expect(pickExperiment(a.id).ok).toBe(true);
    const denied = pickExperiment(b.id);
    expect(denied.ok).toBe(false);
    // cancel returns a to queued and frees the slot
    expect(cancelScheduling(a.id).ok).toBe(true);
    expect(db.select().from(experiment).where(eq(experiment.id, a.id)).get()!.status).toBe("queued");
    expect(pickExperiment(b.id).ok).toBe(true);
  });

  test("cannot commit without scheduling, cannot end without running", () => {
    const exp = queued();
    expect(commitPlan(exp.id, PLAN).ok).toBe(false);
    expect(endExperiment(exp.id, "succeeded").ok).toBe(false);
  });

  test("succeeded: building habits graduate to established, evidence lands on goals", () => {
    const g = makeGoal();
    const exp = queued("t", [g.id]);
    pickExperiment(exp.id);
    commitPlan(exp.id, PLAN);
    const ended = endExperiment(exp.id, "succeeded", "the mornings are mine now");
    expect(ended.ok).toBe(true);

    const h = db.select().from(habit).where(eq(habit.experimentId, exp.id)).get()!;
    expect(h.status).toBe("established");
    const evidence = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(evidence.some(e => e.note?.includes("succeeded"))).toBe(true);
    expect(attemptCounts().get(g.id)).toBe(1); // heatmap increments
  });

  test("failed: blame-free — habits lapse (not deleted), open tasks skip, done tasks stay", () => {
    const g = makeGoal();
    const exp = queued("t", [g.id]);
    pickExperiment(exp.id);
    commitPlan(exp.id, PLAN);
    const tasks = db.select().from(experimentTask).where(eq(experimentTask.experimentId, exp.id)).all();
    patchTask(tasks[0]!.id, "done");

    expect(endExperiment(exp.id, "failed", "phone crept back by day 3 — need a charger in the kitchen").ok).toBe(true);
    const h = db.select().from(habit).where(eq(habit.experimentId, exp.id)).get()!;
    expect(h.status).toBe("lapsed"); // row survives; statuses only
    const after = db.select().from(experimentTask).where(eq(experimentTask.experimentId, exp.id)).all();
    expect(after.find(t => t.id === tasks[0]!.id)!.status).toBe("done");
    expect(after.find(t => t.id === tasks[1]!.id)!.status).toBe("skipped");
    expect(attemptCounts().get(g.id)).toBe(1); // failures count as attempts too
  });

  test("no double-end", () => {
    const exp = queued();
    pickExperiment(exp.id);
    commitPlan(exp.id, PLAN);
    expect(endExperiment(exp.id, "failed").ok).toBe(true);
    expect(endExperiment(exp.id, "succeeded").ok).toBe(false);
  });

  test("archive is queue-only", () => {
    const exp = queued();
    expect(archiveExperiment(exp.id).ok).toBe(true);
    expect(db.select().from(experiment).where(eq(experiment.id, exp.id)).get()!.status).toBe("archived");
    const exp2 = queued("running one");
    pickExperiment(exp2.id);
    expect(archiveExperiment(exp2.id).ok).toBe(false);
  });

  test("currentExperiment: running wins, else queue head; queue lists queued+scheduling", () => {
    expect(currentExperiment()).toBeNull();
    const a = queued("a");
    const b = queued("b");
    expect(currentExperiment()!.id).toBe(a.id);
    pickExperiment(a.id);
    commitPlan(a.id, PLAN);
    expect(currentExperiment()!.id).toBe(a.id);
    expect(currentExperiment()!.isRunning).toBe(true);
    expect(listQueue().map(e => e.id)).toEqual([b.id]);
  });

  test("entity detail: goal shows attempt archaeology; habit shows lineage", () => {
    const g = makeGoal();
    const exp = queued("t", [g.id]);
    pickExperiment(exp.id);
    commitPlan(exp.id, PLAN);
    endExperiment(exp.id, "failed", "charger crept back — kitchen next time");

    const gd = goalDetail(g.id)!;
    expect(gd.attemptCount).toBe(1);
    expect(gd.experiments).toHaveLength(1);
    expect(gd.experiments[0]!.status).toBe("failed");
    expect(gd.experiments[0]!.outcomeMd).toContain("kitchen");

    const h = db.select().from(habit).where(eq(habit.experimentId, exp.id)).get()!;
    const hd = habitDetail(h.id)!;
    expect(hd.bornInExperiment!.id).toBe(exp.id);
    expect(hd.bornInExperiment!.outcomeMd).toContain("kitchen");
    expect(hd.status).toBe("lapsed");
  });

  // (task copy-prompt removed: system-initiated context gathering happens
  // in-app now — see shaping tests in pipeline.test.ts)
});
