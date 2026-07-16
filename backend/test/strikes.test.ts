import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { conversation, experiment } from "../src/db/schema";
import { seedConfig, setConfig } from "../src/services/config";
import {
  computeStrikes,
  getStrikeState,
  pauseStrikes,
  registerStrikeAlertSink,
  runStrikeCheck,
  type StrikeReport,
} from "../src/services/strikes";
import { computeVitals } from "../src/services/vitals";

// All-derived tripwire: these tests fabricate ONLY normal domain rows
// (conversations, experiments) — there is no counter to seed, which is the
// point. asOf is passed explicitly so every case is deterministic.

const ASOF = "2026-07-14";

function daysAgo(n: number): string {
  return new Date(Date.parse(`${ASOF}T12:00:00`) - n * 86_400_000).toISOString();
}

function acceptedRant(agoDays: number) {
  return db
    .insert(conversation)
    .values({
      externalId: crypto.randomUUID(),
      title: "a rant",
      rawJson: "{}",
      contentJson: "[]",
      rantVerdict: "candidate",
      rantStatus: "accepted",
      rantResolvedAt: daysAgo(agoDays),
      distillRequested: true,
      createdAt: daysAgo(agoDays),
    })
    .returning()
    .get();
}

function endedExperiment(agoDays: number, status: "succeeded" | "failed" = "succeeded") {
  return db
    .insert(experiment)
    .values({ title: "done", kind: "actionable", status, endedAt: daysAgo(agoDays) })
    .returning()
    .get();
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
  registerStrikeAlertSink(null);
});

describe("rant clock", () => {
  test("3/6/9 quiet days → 1/2/3 strikes", () => {
    for (const [quiet, expected] of [
      [2, 0],
      [3, 1],
      [6, 2],
      [9, 3],
    ] as const) {
      wipeAllTables();
      seedConfig();
      acceptedRant(quiet);
      const r = computeStrikes(ASOF);
      expect(r.rantStrikes).toBe(expected);
    }
  });

  test("a fresh accepted rant resets the clock to zero by pure math", () => {
    acceptedRant(9);
    expect(computeStrikes(ASOF).rantStrikes).toBe(3);
    acceptedRant(0); // contact: new rant today
    expect(computeStrikes(ASOF).rantStrikes).toBe(0);
  });

  test("cold start (no rant ever) never strikes", () => {
    expect(computeStrikes(ASOF).total).toBe(0);
  });
});

describe("queue clock", () => {
  test("raw candidates do not load the heartbeat or queue clock", () => {
    acceptedRant(0);
    db.insert(experiment)
      .values({ title: "candidate that looks live", kind: "candidate", status: "running", startedAt: daysAgo(3) })
      .run();
    db.insert(experiment)
      .values({ title: "candidate that looks queued", kind: "candidate", status: "queued" })
      .run();
    db.insert(experiment)
      .values({ title: "candidate that looks ended", kind: "candidate", status: "failed", endedAt: daysAgo(4) })
      .run();

    const vitals = computeVitals(ASOF);
    expect(vitals.experiment.running).toBeNull();
    expect(vitals.experiment.queueDepth).toBe(0);
    expect(vitals.experiment.lastEndedAt).toBeNull();
    expect(computeStrikes(ASOF).queueStrikes).toBe(0);
  });

  test("1 strike per empty-queue day after an experiment ends", () => {
    acceptedRant(0); // keep the rant clock quiet
    endedExperiment(4);
    const r = computeStrikes(ASOF);
    expect(r.queueStrikes).toBe(4);
    expect(r.total).toBe(4);
  });

  test("queueing or running anything zeroes it", () => {
    acceptedRant(0);
    endedExperiment(4);
    db.insert(experiment).values({ title: "next", kind: "actionable", status: "queued" }).run();
    expect(computeStrikes(ASOF).queueStrikes).toBe(0);
  });

  test("same-day end is not a strike", () => {
    acceptedRant(0);
    endedExperiment(0);
    expect(computeStrikes(ASOF).queueStrikes).toBe(0);
  });

  test("day-5 nudge is a heads-up on a RUNNING experiment, never a strike", () => {
    acceptedRant(0);
    db.insert(experiment)
      .values({ title: "live", kind: "actionable", status: "running", startedAt: daysAgo(5), plannedDurationDays: 7 })
      .run();
    const r = computeStrikes(ASOF);
    expect(r.queueNudge).toBe(true);
    expect(r.queueStrikes).toBe(0);
    // queue something → nudge clears
    db.insert(experiment).values({ title: "next", kind: "actionable", status: "queued" }).run();
    expect(computeStrikes(ASOF).queueNudge).toBe(false);
  });
});

describe("pause mode", () => {
  test("active pause suspends both clocks", () => {
    acceptedRant(9);
    endedExperiment(4);
    pauseStrikes(10, "traveling");
    const r = computeStrikes(ASOF);
    expect(r.paused).toBe(true);
    expect(r.total).toBe(0);
  });

  test("after a pause ends, only post-pause days count", () => {
    acceptedRant(20);
    // Pause covered until 6 days ago → rant clock restarts there: 6 quiet days = 2 strikes.
    getStrikeState();
    const pauseEnd = new Date(Date.parse(`${ASOF}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    db.run(sql`UPDATE strike_state SET paused_until = ${pauseEnd}`);
    const r = computeStrikes(ASOF);
    expect(r.paused).toBe(false);
    expect(r.rantStrikes).toBe(2);
  });
});

describe("threshold + armed (one alert per episode)", () => {
  const fired: StrikeReport[] = [];
  const sink = async (_body: string, report: StrikeReport) => {
    fired.push(report);
    return "witness-1";
  };

  beforeEach(() => {
    fired.length = 0;
  });

  test("dark mode: threshold crossed → correct count, NO alert, armed untouched", async () => {
    registerStrikeAlertSink(sink);
    acceptedRant(9); // 3 strikes ≥ threshold 3
    const r = await runStrikeCheck(ASOF);
    expect(r.total).toBe(3);
    expect(r.alertFired).toBe(false);
    expect(r.armed).toBe(true);
    expect(fired).toHaveLength(0);
  });

  test("live: one alert on cross, no drumbeat, re-arms only after contact", async () => {
    registerStrikeAlertSink(sink);
    setConfig("STRIKE_ALERTS_ENABLED", true);
    acceptedRant(9);

    const first = await runStrikeCheck(ASOF);
    expect(first.alertFired).toBe(true);
    expect(fired).toHaveLength(1);

    const second = await runStrikeCheck(ASOF); // next heartbeat, same episode
    expect(second.alertFired).toBe(false);
    expect(fired).toHaveLength(1); // no drumbeat

    acceptedRant(0); // contact — episode over
    const third = await runStrikeCheck(ASOF);
    expect(third.total).toBe(0);
    expect(third.armed).toBe(true); // re-armed

    // A NEW episode can alert again.
    db.run(sql`DELETE FROM conversation`);
    acceptedRant(9);
    const fourth = await runStrikeCheck(ASOF);
    expect(fourth.alertFired).toBe(true);
    expect(fired).toHaveLength(2);
  });

  test("live but no sink registered (no witness infra) → still dark", async () => {
    setConfig("STRIKE_ALERTS_ENABLED", true);
    acceptedRant(9);
    const r = await runStrikeCheck(ASOF);
    expect(r.alertFired).toBe(false);
    expect(r.armed).toBe(true);
  });

  test("alert body is factual template fill, no verdicts", async () => {
    registerStrikeAlertSink(async (body, report) => {
      expect(body).toContain("no new rants in 9 days");
      expect(body).toContain("ask what's in the way");
      expect(body.toLowerCase()).not.toContain("fucked");
      expect(body.toLowerCase()).not.toContain("failed");
      return "witness-1";
    });
    setConfig("STRIKE_ALERTS_ENABLED", true);
    acceptedRant(9);
    const r = await runStrikeCheck(ASOF);
    expect(r.alertFired).toBe(true);
  });
});
