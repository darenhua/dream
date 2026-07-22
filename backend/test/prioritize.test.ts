import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { currentFocus, experimentGroup } from "../src/db/schema";
import { currentPick, prioritizeContext } from "../src/services/prioritize";
import { applyRecordChangeSet, createRecordChangeSet } from "../src/services/recordChangeSets";

beforeEach(() => wipeAllTables());

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function makeGroupWithIdeas(title = "becoming outgoing") {
  const cs = createRecordChangeSet({
    summaryMd: "group creation",
    operations: [
      { op: "create", tempId: "goal", model: "organized_goal", role: "satellite", fields: { title: "higher agency" } },
      { op: "create", tempId: "idea", model: "experiment_idea", role: "satellite", fields: { title: "throw a house party" } },
      { op: "create", tempId: "group", model: "experiment_group", role: "central", fields: { title, theme: "outgoing & self-expressive" } },
      { op: "link", relation: "idea_goal", from: "temp:idea", to: "temp:goal", description: "forces hosting" },
      { op: "link", relation: "group_idea", from: "temp:group", to: "temp:idea" },
      { op: "link", relation: "group_goal", from: "temp:group", to: "temp:goal", rank: 0 },
    ],
  });
  const result = applyRecordChangeSet(cs.id);
  expect(result.ok).toBe(true);
  const applied = result.ok ? result.changeSet.appliedRecords! : {};
  return { groupLineageId: applied.group!.lineageId, goalLineageId: applied.goal!.lineageId };
}

describe("prioritize", () => {
  test("context lists candidate groups with goal sets and done counts", () => {
    makeGroupWithIdeas();
    const ctx = prioritizeContext();
    expect(ctx.currentPick).toBeNull();
    expect(ctx.candidates).toHaveLength(1);
    expect(ctx.candidates[0]!.goalSet[0]!.title).toBe("higher agency");
    expect(ctx.candidates[0]!.ideaCount).toBe(1);
    expect(ctx.candidates[0]!.ideasDone).toBe(0);
  });

  test("a standalone pick change set creates the current focus with a pinned version and end date", () => {
    const { groupLineageId } = makeGroupWithIdeas();
    const cs = createRecordChangeSet({
      summaryMd: "prioritize decision",
      operations: [{ op: "pick", group: groupLineageId, endDate: futureDate(56), reasoning: "conviction: agency matters most now" }],
    });
    expect(applyRecordChangeSet(cs.id).ok).toBe(true);

    const pick = currentPick();
    expect(pick).not.toBeNull();
    expect(pick!.groupLineageId).toBe(groupLineageId);
    const groupVersion = db.select().from(experimentGroup).where(eq(experimentGroup.id, pick!.pick.experimentGroupId)).get()!;
    expect(groupVersion.lineageId).toBe(groupLineageId); // pinned version resolves to the lineage

    const ctx = prioritizeContext();
    expect(ctx.currentPick!.expired).toBe(false);
    expect(ctx.candidates).toHaveLength(0); // the picked group is no longer a candidate
  });

  test("a second pick is refused while one is current", () => {
    const { groupLineageId } = makeGroupWithIdeas();
    const first = createRecordChangeSet({
      summaryMd: "pick",
      operations: [{ op: "pick", group: groupLineageId, endDate: futureDate(30), reasoning: "go" }],
    });
    expect(applyRecordChangeSet(first.id).ok).toBe(true);

    const { groupLineageId: other } = makeGroupWithIdeas("ship and be seen");
    const second = createRecordChangeSet({
      summaryMd: "pick again",
      operations: [{ op: "pick", group: other, endDate: futureDate(30), reasoning: "no" }],
    });
    const result = applyRecordChangeSet(second.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("current pick already exists");
  });

  test("an expired pick re-arms prioritization and is auto-ended by the next pick", () => {
    const { groupLineageId } = makeGroupWithIdeas();
    const first = createRecordChangeSet({
      summaryMd: "pick",
      operations: [{ op: "pick", group: groupLineageId, endDate: futureDate(30), reasoning: "go" }],
    });
    expect(applyRecordChangeSet(first.id).ok).toBe(true);
    // simulate expiry
    db.update(currentFocus).set({ endDate: "2020-01-01" }).run();
    expect(currentPick()).toBeNull();

    const { groupLineageId: next } = makeGroupWithIdeas("round two");
    const second = createRecordChangeSet({
      summaryMd: "re-pick",
      operations: [{ op: "pick", group: next, endDate: futureDate(30), reasoning: "picking up where we left off" }],
    });
    expect(applyRecordChangeSet(second.id).ok).toBe(true);
    const picks = db.select().from(currentFocus).all();
    expect(picks.filter(p => p.endedAt === null)).toHaveLength(1);
    expect(currentPick()!.groupLineageId).toBe(next);
  });

  test("pick can ride with the creates of a new group in one change set", () => {
    const cs = createRecordChangeSet({
      summaryMd: "new group + pick together",
      operations: [
        { op: "create", tempId: "goal", model: "organized_goal", role: "satellite", fields: { title: "be a better engineer" } },
        { op: "create", tempId: "group", model: "experiment_group", role: "central", fields: { title: "ship week rhythm" } },
        { op: "link", relation: "group_goal", from: "temp:group", to: "temp:goal", rank: 0 },
        { op: "pick", group: "temp:group", endDate: futureDate(42), reasoning: "start now" },
      ],
    });
    expect(applyRecordChangeSet(cs.id).ok).toBe(true);
    expect(currentPick()).not.toBeNull();
  });

  test("group branching: a v2 of an expired pick's group becomes a fresh candidate", () => {
    const { groupLineageId } = makeGroupWithIdeas();
    const pick = createRecordChangeSet({
      summaryMd: "pick",
      operations: [{ op: "pick", group: groupLineageId, endDate: futureDate(30), reasoning: "go" }],
    });
    expect(applyRecordChangeSet(pick.id).ok).toBe(true);
    db.update(currentFocus).set({ endDate: "2020-01-01" }).run();

    // version-bump the group (picking up where it left off)
    const v2 = createRecordChangeSet({
      summaryMd: "group v2 after expiry",
      operations: [
        { op: "create", tempId: "g2", model: "experiment_group", role: "central", fields: { title: "becoming outgoing", description: "round 2: the party happened, content did not" } },
      ],
    });
    expect(applyRecordChangeSet(v2.id, { g2: { verdict: "version_bump", ofLineageId: groupLineageId } }).ok).toBe(true);

    const ctx = prioritizeContext();
    expect(ctx.currentPick!.expired).toBe(true);
    expect(ctx.candidates).toHaveLength(1);
    expect(ctx.candidates[0]!.version).toBe(2);
    expect(ctx.candidates[0]!.ideaCount).toBe(1); // membership followed the lineage for free
  });
});
