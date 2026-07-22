import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import {
  environmentItem,
  experimentIdea,
  goalHabit,
  goalPattern,
  habit,
  ideaGoal,
  lineageParent,
  organizedGoal,
} from "../src/db/schema";
import {
  applyRecordChangeSet,
  createRecordChangeSet,
  getRecordChangeSet,
  listRecordChangeSets,
  reconcileRecordChangeSet,
  rejectRecordChangeSet,
  reviseRecordChangeSet,
} from "../src/services/recordChangeSets";

beforeEach(() => wipeAllTables());

// The archetype goal-rant change set: central goal + bad habit + pattern +
// idea + environment chained through the habit, with why-bearing links.
function goalRantOperations() {
  return [
    { op: "create", tempId: "goal", model: "organized_goal", role: "central", fields: { title: "higher agency", description: "what it means to me" } },
    { op: "create", tempId: "habit", model: "habit", role: "satellite", fields: { title: "doomscroll shame cycle", description: "nightly loop" } },
    { op: "create", tempId: "pattern", model: "pattern_of_behavior", role: "satellite", fields: { title: "shame spiral", description: "trigger: comparison; coping: going dark" } },
    { op: "create", tempId: "idea", model: "experiment_idea", role: "satellite", fields: { title: "tell a girl she's beautiful", description: "scary in the right way" } },
    { op: "create", tempId: "env", model: "environment_item", role: "satellite", fields: { title: "phone in bedroom", description: "makes the loop easy", habitLineageId: "temp:habit", effect: "easier" } },
    { op: "link", relation: "goal_habit", from: "temp:goal", to: "temp:habit", description: "removing this is part of the goal" },
    { op: "link", relation: "goal_pattern", from: "temp:goal", to: "temp:pattern" },
    { op: "link", relation: "idea_goal", from: "temp:idea", to: "temp:goal", description: "confidence reps in public" },
  ];
}

describe("record change sets", () => {
  test("submit → apply creates versioned rows, links, and applied provenance", () => {
    const cs = createRecordChangeSet({ summaryMd: "goal rant digest", operations: goalRantOperations() });
    expect(cs.status).toBe("ready_for_review");
    expect(cs.markerToken).toMatch(/^rc_/);

    const result = applyRecordChangeSet(cs.id);
    expect(result.ok).toBe(true);
    const applied = getRecordChangeSet(cs.id)!;
    expect(applied.status).toBe("applied");
    expect(Object.keys(applied.appliedRecords!)).toHaveLength(5);

    const goalRow = db.select().from(organizedGoal).all()[0]!;
    expect(goalRow.lineageId).toBe(goalRow.id);
    expect(goalRow.version).toBe(1);

    const habitRow = db.select().from(habit).all()[0]!;
    const envRow = db.select().from(environmentItem).all()[0]!;
    expect(envRow.habitLineageId).toBe(habitRow.lineageId); // temp ref resolved
    expect(envRow.effect).toBe("easier");

    const gh = db.select().from(goalHabit).all()[0]!;
    expect(gh.goalId).toBe(goalRow.lineageId!);
    expect(gh.description).toContain("removing this");
    expect(db.select().from(goalPattern).all()).toHaveLength(1);
    expect(db.select().from(ideaGoal).all()[0]!.description).toContain("confidence reps");
  });

  test("version_bump verdict creates v2 in the same lineage; links follow for free", () => {
    const first = createRecordChangeSet({
      summaryMd: "quick capture",
      operations: [
        { op: "create", tempId: "idea", model: "experiment_idea", role: "central", fields: { title: "try tennis", description: "one-liner" } },
      ],
    });
    applyRecordChangeSet(first.id);
    const v1 = db.select().from(experimentIdea).all()[0]!;

    const second = createRecordChangeSet({
      summaryMd: "expanded in a focused thread",
      operations: [
        { op: "create", tempId: "idea2", model: "experiment_idea", role: "central", fields: { title: "try tennis", description: "weekly lesson at the club" } },
      ],
    });
    const result = applyRecordChangeSet(second.id, { idea2: { verdict: "version_bump", ofLineageId: v1.lineageId! } });
    expect(result.ok).toBe(true);
    const rows = db.select().from(experimentIdea).where(eq(experimentIdea.lineageId, v1.lineageId!)).all();
    expect(rows).toHaveLength(2);
    const v2 = rows.find(r => r.version === 2)!;
    expect(v2.prevVersionId).toBe(v1.id);
  });

  test("remix verdict creates a new lineage with parent links; link_existing dedupes", () => {
    const seed = createRecordChangeSet({
      summaryMd: "seed",
      operations: [
        { op: "create", tempId: "party", model: "experiment_idea", role: "central", fields: { title: "throw a house party", description: "for twenty friends" } },
      ],
    });
    applyRecordChangeSet(seed.id);
    const party = db.select().from(experimentIdea).all()[0]!;

    const remix = createRecordChangeSet({
      summaryMd: "monthly party series spin-off, also re-mentions the original",
      operations: [
        { op: "create", tempId: "series", model: "experiment_idea", role: "central", fields: { title: "monthly themed party series", description: "derived from the one-off" } },
        { op: "create", tempId: "dupe", model: "experiment_idea", role: "satellite", fields: { title: "throw a house party", description: "the same old idea" } },
        { op: "link", relation: "idea_project", from: "temp:series", to: "temp:dupe" },
      ],
    });
    const result = applyRecordChangeSet(remix.id, {
      series: { verdict: "remix", parents: [{ model: "experiment_idea", versionId: party.id }] },
      dupe: { verdict: "link_existing", lineageId: party.lineageId! },
    });
    expect(result.ok).toBe(true);
    expect(db.select().from(experimentIdea).all()).toHaveLength(2); // no dupe row inserted
    const parent = db.select().from(lineageParent).all().find(r => r.parentVersionId === party.id)!;
    expect(parent.childType).toBe("experiment_idea");
  });

  test("reject with feedback returns to drafting; revision resubmits same marker", () => {
    const cs = createRecordChangeSet({
      summaryMd: "first pass",
      operations: [
        { op: "create", tempId: "t", model: "task", role: "central", fields: { title: "book dermatologist", deadlineDate: "2026-09-01" } },
      ],
    });
    const returned = rejectRecordChangeSet(cs.id, { feedback: "the deadline is wrong", returnToDrafting: true })!;
    expect(returned.status).toBe("drafting");
    expect(returned.rejectionNote).toContain("deadline");

    const revised = reviseRecordChangeSet(cs.id, {
      summaryMd: "fixed deadline",
      operations: [
        { op: "create", tempId: "t", model: "task", role: "central", fields: { title: "book dermatologist", deadlineDate: "2026-08-15" } },
      ],
    });
    expect(revised.status).toBe("ready_for_review");
    expect(revised.markerToken).toBe(cs.markerToken);
    expect(applyRecordChangeSet(cs.id).ok).toBe(true);
  });

  test("validation: exactly one central; unknown temp refs rejected; bad fields rejected", () => {
    expect(() =>
      createRecordChangeSet({ summaryMd: "x", operations: [{ op: "create", tempId: "a", model: "task", role: "satellite", fields: { title: "t" } }] }),
    ).toThrow(/central/);
    expect(() =>
      createRecordChangeSet({
        summaryMd: "x",
        operations: [
          { op: "create", tempId: "a", model: "task", role: "central", fields: { title: "t" } },
          { op: "link", relation: "idea_goal", from: "temp:missing", to: "temp:a" },
        ],
      }),
    ).toThrow(/unknown/);
    expect(() =>
      createRecordChangeSet({
        summaryMd: "x",
        operations: [{ op: "create", tempId: "a", model: "task", role: "central", fields: { title: "t", smuggled: true } }],
      }),
    ).toThrow();
  });

  test("reconciliation: deterministic candidates + mocked agent verdicts land in the report", async () => {
    const seed = createRecordChangeSet({
      summaryMd: "seed",
      operations: [
        { op: "create", tempId: "g", model: "organized_goal", role: "central", fields: { title: "become more athletic", description: "move every day" } },
      ],
    });
    applyRecordChangeSet(seed.id);
    const existing = db.select().from(organizedGoal).all()[0]!;

    const cs = createRecordChangeSet({
      summaryMd: "another rant grazes the same goal",
      operations: [
        { op: "create", tempId: "g2", model: "organized_goal", role: "central", fields: { title: "more athletic than ever", description: "gym, tennis, movement" } },
      ],
    });
    const mockRunner = async () => ({
      runId: null,
      status: "ok" as const,
      output: { verdicts: [{ temp_id: "g2", verdict: "version_bump" as const, of_lineage_id: existing.lineageId!, reason: "same goal, more detail" }] },
    });
    const report = await reconcileRecordChangeSet(cs.id, { runner: mockRunner });
    expect(report!.candidates.g2!.some(c => c.lineageId === existing.lineageId)).toBe(true);
    expect(report!.verdicts!.g2).toEqual({ verdict: "version_bump", ofLineageId: existing.lineageId! });

    // apply consumes the stored suggestion when no override is passed
    const result = applyRecordChangeSet(cs.id);
    expect(result.ok).toBe(true);
    const rows = db.select().from(organizedGoal).where(eq(organizedGoal.lineageId, existing.lineageId!)).all();
    expect(rows.map(r => r.version).sort()).toEqual([1, 2]);
  });

  test("workspace-less listing ignores legacy collaboration change sets", () => {
    createRecordChangeSet({
      summaryMd: "mine",
      operations: [{ op: "create", tempId: "t", model: "project", role: "central", fields: { title: "workout buddy app" } }],
    });
    expect(listRecordChangeSets("ready_for_review")).toHaveLength(1);
  });
});
