import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { calendarEvent, experiment, experimentGroup, experimentTask, outboundMessage, witness } from "../src/db/schema";
import { seedConfig, setConfig } from "../src/services/config";
import { runDutyPings } from "../src/services/dutyPings";
import { computeVitals } from "../src/services/vitals";

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function activeGroup(title: string, ageHours: number) {
  return db
    .insert(experimentGroup)
    .values({ title, createdAt: hoursAgo(ageHours), updatedAt: hoursAgo(ageHours) })
    .returning()
    .get();
}

function primaryWitness() {
  return db.insert(witness).values({ name: "Accountability friend", status: "active", isPrimary: true }).returning().get();
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
  setConfig("WITNESS_QUIET_HOURS", null);
});

describe("actionable coverage duty pings", () => {
  test("candidate rows never cover a group, and a coverage ping only creates an outbox message", () => {
    setConfig("DUTY_PING_ACTIONABLE_HOURS", 1);
    const group = activeGroup("Make music sustainably", 48);
    const friend = primaryWitness();
    const candidate = db
      .insert(experiment)
      .values({
        title: "raw candidate that must not become a commitment",
        kind: "candidate",
        status: "running",
        experimentGroupId: group.id,
        startedAt: hoursAgo(4),
      })
      .returning()
      .get();

    const vitals = computeVitals(new Date().toISOString().slice(0, 10));
    expect(vitals.experiment.actionableCoverage.groupsWithoutRunning.map(row => row.id)).toEqual([group.id]);
    expect(vitals.experiment.actionableCoverage.groupsWithoutApprovedActionable.map(row => row.id)).toEqual([group.id]);

    const before = {
      experiments: db.select().from(experiment).all().length,
      tasks: db.select().from(experimentTask).all().length,
      calendarEvents: db.select().from(calendarEvent).all().length,
    };
    const report = runDutyPings();

    expect(report.actionableCoverage).toEqual({
      activeGroups: 1,
      groupsWithoutRunning: 1,
      groupsWithoutApprovedActionable: 1,
      eligibleGroups: 1,
      pings: 1,
    });
    expect(db.select().from(experiment).all()).toHaveLength(before.experiments);
    expect(db.select().from(experiment).where(eq(experiment.id, candidate.id)).get()!.kind).toBe("candidate");
    expect(db.select().from(experimentTask).all()).toHaveLength(before.tasks);
    expect(db.select().from(calendarEvent).all()).toHaveLength(before.calendarEvents);

    const messages = db.select().from(outboundMessage).all();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      witnessId: friend.id,
      kind: "duty_ping",
      relatedType: "experiment_group",
      relatedId: group.id,
      status: "pending_approval",
    });

    // The same absence episode does not become a repeating queue or a
    // duplicate notification on every heartbeat.
    expect((runDutyPings().actionableCoverage as { pings: number }).pings).toBe(0);
    expect(db.select().from(outboundMessage).all()).toHaveLength(1);
  });

  test("a completed weekly actionable starts a fresh quiet window before the next reminder", () => {
    setConfig("DUTY_PING_ACTIONABLE_HOURS", 24);
    const group = activeGroup("Build a calmer morning", 7 * 24);
    primaryWitness();
    const recentlyEnded = db
      .insert(experiment)
      .values({
        title: "last week's small action",
        kind: "actionable",
        status: "succeeded",
        experimentGroupId: group.id,
        endedAt: hoursAgo(2),
      })
      .returning()
      .get();

    expect((runDutyPings().actionableCoverage as { eligibleGroups: number; pings: number })).toMatchObject({
      eligibleGroups: 0,
      pings: 0,
    });
    expect(db.select().from(outboundMessage).all()).toHaveLength(0);

    db.update(experiment).set({ endedAt: hoursAgo(26) }).where(eq(experiment.id, recentlyEnded.id)).run();
    expect((runDutyPings().actionableCoverage as { eligibleGroups: number; pings: number })).toMatchObject({
      eligibleGroups: 1,
      pings: 1,
    });
  });
});
