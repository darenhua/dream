import { beforeEach, describe, expect, test } from "bun:test";
import { db, wipeAllTables } from "../src/db";
import { calendarEvent } from "../src/db/schema";
import { createDailyPlan, dailyPlanContext, listDailyPlans, toggleDailyItem } from "../src/services/dailyPlan";
import { applyRecordChangeSet, createRecordChangeSet } from "../src/services/recordChangeSets";

beforeEach(() => wipeAllTables());

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString("en-CA");
}

function seedTaskWithDeadline() {
  const cs = createRecordChangeSet({
    summaryMd: "task",
    operations: [
      { op: "create", tempId: "t", model: "task", role: "central", fields: { title: "book dermatologist", deadlineDate: isoDate(12) } },
    ],
  });
  const result = applyRecordChangeSet(cs.id);
  expect(result.ok).toBe(true);
  return result.ok ? result.changeSet.appliedRecords!.t!.lineageId : "";
}

describe("daily plans", () => {
  test("create_daily_plan writes directly: plan + items + scheduled events", () => {
    const taskLineage = seedTaskWithDeadline();
    const date = isoDate(1);
    const plan = createDailyPlan({
      date,
      theme: "survive the review, then be unreachable",
      description: "reported: energy low, social none, work heavy (2pm design review)",
      items: [
        { kind: "leisure", text: "morning matcha", startAt: `${date}T07:40:00.000Z`, endAt: `${date}T08:00:00.000Z` },
        { kind: "block", text: "call dermatologist", startAt: `${date}T12:15:00.000Z`, endAt: `${date}T12:30:00.000Z`, taskLineageId: taskLineage },
        { kind: "todo", text: "one street compliment" },
      ],
    });
    expect(plan.items).toHaveLength(3);
    const events = db.select().from(calendarEvent).all();
    expect(events).toHaveLength(2); // matcha + dermatologist call; the todo stays unscheduled
    expect(events.map(e => e.entityType).sort()).toEqual(["leisure", "task"]);

    // duplicate date refused
    expect(() => createDailyPlan({ date, theme: "again", description: "x" })).toThrow(/already exists/);
  });

  test("done-toggle stamps item and its calendar event (the habit signal)", () => {
    const date = isoDate(1);
    const plan = createDailyPlan({
      date,
      theme: "t",
      description: "d",
      items: [{ kind: "leisure", text: "walk", startAt: `${date}T13:00:00.000Z`, endAt: `${date}T13:30:00.000Z` }],
    });
    toggleDailyItem(plan.items[0]!.id, true);
    const event = db.select().from(calendarEvent).all()[0]!;
    expect(event.completedAt).not.toBeNull();
  });

  test("context windows to ~7 recent plans, nags unanchored deadline tasks, reads yesterday's state", () => {
    seedTaskWithDeadline();
    for (let i = 9; i >= 1; i--) {
      createDailyPlan({ date: isoDate(-i), theme: `day -${i}`, description: i === 1 ? "reported: running on fumes" : "fine" });
    }
    const ctx = dailyPlanContext(isoDate(0));
    expect(ctx.recentDailyPlans).toHaveLength(7); // windowed, not all 9
    expect(ctx.recentDailyPlans[0]!.description).toContain("fumes"); // newest first: yesterday's state
    const nag = ctx.openTasks.find(t => t.title.includes("dermatologist"))!;
    expect(nag.anchored).toBe(false);
    expect(nag.deadlineDate).toBe(isoDate(12));
    expect(ctx.workContext).toBe("");
    expect(listDailyPlans(50)).toHaveLength(9);
  });
});
