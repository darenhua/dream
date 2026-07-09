import { beforeEach, describe, expect, test } from "bun:test";
import { wipeAllTables, db } from "../src/db";
import { anchorEvent } from "../src/db/schema";
import { seedConfig, setConfig } from "../src/services/config";
import { computeFreeDay, effectiveWindows, type DayWindows } from "../src/services/freeTime";
import { hhmmToMin, minToHhmm, zonedIso, localMinutes } from "../src/lib/time";

const BASE: DayWindows = {
  sleepStart: hhmmToMin("23:30"),
  sleepEnd: hhmmToMin("07:30"),
  workStart: hhmmToMin("09:30"),
  workEnd: hhmmToMin("18:00"),
  dinner: null,
};

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

describe("computeFreeDay (pure)", () => {
  test("midnight-wrapping sleep blocks both edges of the day", () => {
    const free = computeFreeDay(BASE, []);
    // free: 07:30–09:30 and 18:00–23:30
    expect(free).toEqual([
      { start: hhmmToMin("07:30"), end: hhmmToMin("09:30") },
      { start: hhmmToMin("18:00"), end: hhmmToMin("23:30") },
    ]);
  });

  test("non-wrapping sleep window is a single block", () => {
    const free = computeFreeDay({ ...BASE, sleepStart: hhmmToMin("01:00"), sleepEnd: hhmmToMin("09:00") }, []);
    expect(free[0]).toEqual({ start: 0, end: hhmmToMin("01:00") });
  });

  test("busy events and dinner subtract; sub-15-minute slivers drop", () => {
    const free = computeFreeDay(
      { ...BASE, dinner: { start: hhmmToMin("19:00"), end: hhmmToMin("20:00") } },
      [{ start: hhmmToMin("18:00"), end: hhmmToMin("18:50") }],
    );
    // evening: 18:50–19:00 (10m, dropped), 20:00–23:30
    expect(free).toEqual([
      { start: hhmmToMin("07:30"), end: hhmmToMin("09:30") },
      { start: hhmmToMin("20:00"), end: hhmmToMin("23:30") },
    ]);
  });

  test("overlapping busy intervals merge", () => {
    const free = computeFreeDay(BASE, [
      { start: hhmmToMin("19:00"), end: hhmmToMin("20:00") },
      { start: hhmmToMin("19:30"), end: hhmmToMin("21:00") },
    ]);
    expect(free).toContainEqual({ start: hhmmToMin("21:00"), end: hhmmToMin("23:30") });
    expect(free).toContainEqual({ start: hhmmToMin("18:00"), end: hhmmToMin("19:00") });
  });

  test("today clamps to now", () => {
    const free = computeFreeDay(BASE, [], hhmmToMin("20:00"));
    expect(free).toEqual([{ start: hhmmToMin("20:00"), end: hhmmToMin("23:30") }]);
  });

  test("no work on weekends (null work window)", () => {
    const free = computeFreeDay({ ...BASE, workStart: null, workEnd: null }, []);
    expect(free).toEqual([{ start: hhmmToMin("07:30"), end: hhmmToMin("23:30") }]);
  });
});

describe("effectiveWindows (anchors override defaults)", () => {
  test("a wake_up tap moves sleepEnd; end_work tap moves workEnd", () => {
    setConfig("TIMEZONE", "UTC"); // deterministic in tests
    const date = "2026-07-08"; // a Wednesday — workday
    const windows = effectiveWindows(date);
    expect(windows.sleepEnd).toBe(hhmmToMin("07:30"));
    expect(windows.workStart).toBe(hhmmToMin("09:30"));

    db.insert(anchorEvent)
      .values({ kind: "wake_up", date, at: `${date}T09:15:00.000Z` })
      .run();
    db.insert(anchorEvent)
      .values({ kind: "end_work", date, at: `${date}T20:00:00.000Z` })
      .run();
    const overridden = effectiveWindows(date);
    expect(overridden.sleepEnd).toBe(hhmmToMin("09:15")); // late wake-up, blame-free
    expect(overridden.workEnd).toBe(hhmmToMin("20:00")); // long day, blame-free
  });

  test("weekend has no work window", () => {
    setConfig("TIMEZONE", "UTC");
    const windows = effectiveWindows("2026-07-11"); // a Saturday
    expect(windows.workStart).toBeNull();
  });
});

describe("time helpers", () => {
  test("hhmm round-trips", () => {
    expect(minToHhmm(hhmmToMin("07:30"))).toBe("07:30");
    expect(minToHhmm(0)).toBe("00:00");
  });

  test("zonedIso handles offsets (incl. DST-observing zones)", () => {
    // 09:00 New York in July = 13:00 UTC (EDT, -4)
    expect(zonedIso("America/New_York", "2026-07-08", hhmmToMin("09:00"))).toBe("2026-07-08T13:00:00.000Z");
    // 09:00 New York in January = 14:00 UTC (EST, -5)
    expect(zonedIso("America/New_York", "2026-01-08", hhmmToMin("09:00"))).toBe("2026-01-08T14:00:00.000Z");
  });

  test("localMinutes converts an instant into tz minutes", () => {
    expect(localMinutes("UTC", new Date("2026-07-08T20:00:00Z"))).toBe(hhmmToMin("20:00"));
    expect(localMinutes("America/New_York", new Date("2026-07-08T20:00:00Z"))).toBe(hhmmToMin("16:00"));
  });
});
