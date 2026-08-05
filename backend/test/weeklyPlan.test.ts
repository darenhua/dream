import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { calendarEvent, groupIdea, habit } from "../src/db/schema";
import { applyRecordChangeSet, createRecordChangeSet } from "../src/services/recordChangeSets";
import { listWeeklyPlans, toggleWeeklyItem, weeklyPlanContext } from "../src/services/weeklyPlan";
import { currentPick } from "../src/services/prioritize";

beforeEach(() => wipeAllTables());

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function nextMonday(offsetWeeks = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + offsetWeeks * 7);
  // Render in LOCAL time (getDay above is local too) — toISOString would flip
  // to tomorrow's date every evening once the process runs in a real timezone.
  return d.toLocaleDateString("en-CA");
}

function bootstrapPick() {
  const cs = createRecordChangeSet({
    summaryMd: "group + pick",
    operations: [
      { op: "create", tempId: "goal", model: "organized_goal", role: "satellite", fields: { title: "higher agency" } },
      { op: "create", tempId: "party", model: "experiment_idea", role: "satellite", fields: { title: "throw a house party" } },
      { op: "create", tempId: "group", model: "experiment_group", role: "central", fields: { title: "becoming outgoing", theme: "outgoing & self-expressive" } },
      { op: "link", relation: "idea_goal", from: "temp:party", to: "temp:goal", description: "forces hosting" },
      { op: "link", relation: "group_idea", from: "temp:group", to: "temp:party" },
      { op: "link", relation: "group_goal", from: "temp:group", to: "temp:goal", rank: 0 },
      { op: "pick", group: "temp:group", endDate: futureDate(56), reasoning: "agency now" },
    ],
  });
  const result = applyRecordChangeSet(cs.id);
  expect(result.ok).toBe(true);
  return result.ok ? result.changeSet.appliedRecords! : {};
}

function weeklyOp(weekOf: string, extra: Record<string, unknown> = {}) {
  return {
    op: "create_weekly_plan",
    weekOf,
    theme: "commit week — make the party un-cancellable",
    description: "weekly goal: send the date. reported: capacity medium, fear 6/10",
    items: [
      { kind: "todo", text: "send date to the group chat" },
      { kind: "intention", text: "one street compliment" },
    ],
    habitStarts: [
      {
        title: "no phones before bed",
        rrule: "FREQ=DAILY",
        firstStartAt: "2026-08-03T20:00:00.000Z",
        firstEndAt: "2026-08-03T20:30:00.000Z",
      },
    ],
    anchoredEvents: [{ title: "hang with Alex", startAt: "2026-08-05T22:00:00.000Z", endAt: "2026-08-06T00:00:00.000Z" }],
    ...extra,
  };
}

describe("weekly plans", () => {
  test("weekly plan op materializes habits + calendar rows + items, no statuses", () => {
    bootstrapPick();
    const cs = createRecordChangeSet({ summaryMd: "week 1", operations: [weeklyOp(nextMonday())] });
    expect(applyRecordChangeSet(cs.id).ok).toBe(true);

    const pick = currentPick()!;
    const plans = listWeeklyPlans(pick.pick.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.theme).toContain("commit week");
    expect(plans[0]!.items).toHaveLength(2);
    expect(plans[0]!.items.every(i => i.doneAt === null)).toBe(true);

    // the materialization boundary: system habit born at week start with its block
    const habits = db.select().from(habit).where(eq(habit.currentFocusId, pick.pick.id)).all();
    expect(habits).toHaveLength(1);
    expect(habits[0]!.origin).toBe("system");
    const events = db.select().from(calendarEvent).all();
    expect(events).toHaveLength(2); // habit block + anchored hang
    expect(events.every(e => e.gcalEventId === null && e.pushedAt === null)).toBe(true); // pending push
  });

  test("duplicate week refused; requires a current pick", () => {
    const noPick = createRecordChangeSet({ summaryMd: "w", operations: [weeklyOp(nextMonday())] });
    const denied = applyRecordChangeSet(noPick.id);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("no current pick");

    bootstrapPick();
    const first = createRecordChangeSet({ summaryMd: "w1", operations: [weeklyOp(nextMonday())] });
    expect(applyRecordChangeSet(first.id).ok).toBe(true);
    const dupe = createRecordChangeSet({ summaryMd: "w1 again", operations: [weeklyOp(nextMonday())] });
    const result = applyRecordChangeSet(dupe.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already exists");
  });

  test("week 2 context reads week 1's completions and idea done-marks", () => {
    const applied = bootstrapPick();
    const w1 = createRecordChangeSet({ summaryMd: "w1", operations: [weeklyOp(nextMonday())] });
    expect(applyRecordChangeSet(w1.id).ok).toBe(true);

    const pick = currentPick()!;
    const plan = listWeeklyPlans(pick.pick.id)[0]!;
    toggleWeeklyItem(plan.items[0]!.id, true); // the manual dashboard CRUD

    // week 2 marks the party idea done in conversation
    const w2 = createRecordChangeSet({
      summaryMd: "w2",
      operations: [
        weeklyOp(nextMonday(1), { theme: "recover + restart content", habitStarts: [], anchoredEvents: [], ideasDone: [applied.party!.lineageId] }),
      ],
    });
    expect(applyRecordChangeSet(w2.id).ok).toBe(true);

    const ctx = weeklyPlanContext();
    expect(ctx.weeklyPlans).toHaveLength(2);
    const week1 = ctx.weeklyPlans!.find(p => p.theme.includes("commit"))!;
    expect(week1.items.find(i => i.text.includes("group chat"))!.doneAt).not.toBeNull();
    const membership = db.select().from(groupIdea).all()[0]!;
    expect(membership.doneAt).not.toBeNull();
    expect(ctx.pick!.weeksRemaining).toBeGreaterThan(0);
    expect((ctx.group!.relations as { memberIdeas: { doneAt: string | null }[] }).memberIdeas[0]!.doneAt).not.toBeNull();
  });
});
