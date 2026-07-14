import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import {
  experiment,
  experimentGoal,
  experimentTask,
  experimentTaskGoal,
  goal,
  goalHabit,
  habit,
  witness,
} from "../src/db/schema";
import { seedConfig } from "../src/services/config";
import { createInvite, linkedPrimaryWitness, setGoals, setPrimary } from "../src/services/witnesses";
import { scopedExperimentView, visibleExperimentIds, witnessContextMd } from "../src/services/witnessScope";

// THE leak test: two goals in different life domains, one experiment spanning
// both, tasks/habits tagged each way, two witnesses scoped oppositely. If any
// cross-goal string ever reaches the other witness's projection, the privacy
// model is broken and nothing downstream (composer, transport) can fix it.

const MUSIC_TASK = "book studio session with SECRET-PRODUCER";
const CAREER_TASK = "schedule the salary talk with SECRET-BOSS";
const MUSIC_HABIT = "morning demo sketch before phone";
const CAREER_HABIT = "friday brag-doc update";
const UNTAGGED_TASK = "buy the UNSPEAKABLE-THING"; // deliberately no goal link

let musicGoal: { id: string };
let careerGoal: { id: string };
let exp: { id: string };

beforeEach(() => {
  wipeAllTables();
  seedConfig();

  musicGoal = db.insert(goal).values({ title: "ship music", identityClause: "I ship a track a month", status: "active", origin: "manual" }).returning().get();
  careerGoal = db.insert(goal).values({ title: "stop people-pleasing", identityClause: "I say the uncomfortable true thing", status: "active", origin: "manual" }).returning().get();

  exp = db.insert(experiment).values({ title: "two-front week", status: "running", startedAt: new Date().toISOString() }).returning().get();
  for (const g of [musicGoal, careerGoal]) {
    db.insert(experimentGoal).values({ experimentId: exp.id, goalId: g.id }).run();
  }

  const musicTask = db.insert(experimentTask).values({ experimentId: exp.id, kind: "setup", title: MUSIC_TASK, status: "pending" }).returning().get();
  db.insert(experimentTaskGoal).values({ experimentTaskId: musicTask.id, goalId: musicGoal.id }).run();
  const careerTask = db.insert(experimentTask).values({ experimentId: exp.id, kind: "experience", title: CAREER_TASK, status: "pending" }).returning().get();
  db.insert(experimentTaskGoal).values({ experimentTaskId: careerTask.id, goalId: careerGoal.id }).run();
  db.insert(experimentTask).values({ experimentId: exp.id, kind: "purchase", title: UNTAGGED_TASK, status: "pending" }).run();

  const musicHabit = db.insert(habit).values({ title: MUSIC_HABIT, valence: "good", status: "building", experimentId: exp.id, origin: "experiment" }).returning().get();
  db.insert(goalHabit).values({ goalId: musicGoal.id, habitId: musicHabit.id }).run();
  const careerHabit = db.insert(habit).values({ title: CAREER_HABIT, valence: "good", status: "building", experimentId: exp.id, origin: "experiment" }).returning().get();
  db.insert(goalHabit).values({ goalId: careerGoal.id, habitId: careerHabit.id }).run();
});

describe("witness goal scoping (fail closed)", () => {
  test("opposite-scoped witnesses never see each other's goal content", () => {
    const friendA = createInvite({ name: "A", goalIds: [musicGoal.id] });
    const friendB = createInvite({ name: "B", goalIds: [careerGoal.id] });

    const ctxA = witnessContextMd(friendA.id);
    expect(ctxA).toContain(MUSIC_TASK);
    expect(ctxA).toContain(MUSIC_HABIT);
    expect(ctxA).not.toContain(CAREER_TASK);
    expect(ctxA).not.toContain(CAREER_HABIT);
    expect(ctxA).not.toContain("SECRET-BOSS");
    expect(ctxA).not.toContain("people-pleasing"); // the other goal's very title

    const ctxB = witnessContextMd(friendB.id);
    expect(ctxB).toContain(CAREER_TASK);
    expect(ctxB).toContain(CAREER_HABIT);
    expect(ctxB).not.toContain(MUSIC_TASK);
    expect(ctxB).not.toContain(MUSIC_HABIT);
    expect(ctxB).not.toContain("SECRET-PRODUCER");
    expect(ctxB).not.toContain("ship music");
  });

  test("untagged tasks are invisible to EVERY witness (fail closed)", () => {
    const friendA = createInvite({ name: "A", goalIds: [musicGoal.id] });
    const friendBoth = createInvite({ name: "Both", goalIds: [musicGoal.id, careerGoal.id] });
    expect(witnessContextMd(friendA.id)).not.toContain("UNSPEAKABLE");
    expect(witnessContextMd(friendBoth.id)).not.toContain("UNSPEAKABLE");
    const view = scopedExperimentView(friendBoth.id, exp.id)!;
    expect(view.tasks.map(t => t.title)).not.toContain(UNTAGGED_TASK);
  });

  test("zero-overlap witness sees no experiment at all", () => {
    const otherGoal = db.insert(goal).values({ title: "unrelated", status: "active", origin: "manual" }).returning().get();
    const stranger = createInvite({ name: "S", goalIds: [otherGoal.id] });
    expect(visibleExperimentIds(stranger.id)).toHaveLength(0);
    expect(scopedExperimentView(stranger.id, exp.id)).toBeNull();
    expect(witnessContextMd(stranger.id)).not.toContain("two-front week");
  });

  test("witness with no goals sees nothing (empty scope is closed, not open)", () => {
    const blank = createInvite({ name: "Blank" });
    expect(visibleExperimentIds(blank.id)).toHaveLength(0);
    expect(witnessContextMd(blank.id)).toContain("no goals shared");
  });

  test("re-scoping swaps visibility immediately", () => {
    const friend = createInvite({ name: "A", goalIds: [musicGoal.id] });
    expect(witnessContextMd(friend.id)).toContain(MUSIC_TASK);
    setGoals(friend.id, [careerGoal.id]);
    const ctx = witnessContextMd(friend.id);
    expect(ctx).not.toContain(MUSIC_TASK);
    expect(ctx).toContain(CAREER_TASK);
  });

  test("exactly one primary; linked-primary requires an active bound chat", () => {
    const a = createInvite({ name: "A", isPrimary: true });
    const b = createInvite({ name: "B" });
    setPrimary(b.id);
    const rows = db.select().from(witness).all();
    expect(rows.filter(w => w.isPrimary)).toHaveLength(1);
    expect(rows.find(w => w.isPrimary)?.id).toBe(b.id);
    // invited but unlinked → tripwire has nobody to alert
    expect(linkedPrimaryWitness()).toBeNull();
    db.update(witness).set({ status: "active", chatId: "chat-guid-1" }).where(eq(witness.id, b.id)).run();
    expect(linkedPrimaryWitness()?.id).toBe(b.id);
  });
});
