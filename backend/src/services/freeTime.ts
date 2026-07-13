import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { anchorEvent } from "../db/schema";
import { dayOfWeek, hhmmToMin, localDate, localMinutes, minToHhmm } from "../lib/time";
import { getConfig } from "./config";

// Free time = the day minus (sleep/work/dinner windows, overridden by that
// day's anchor taps) minus busy calendar events. The pure core takes minute
// intervals so it is unit-testable without Google or a clock.

export interface Interval {
  start: number; // minutes since local midnight
  end: number;
}

export interface DayWindows {
  sleepStart: number; // e.g. 23:30 → 1410 (blocks until midnight; wrap handled)
  sleepEnd: number; // wake, e.g. 07:30 → 450
  workStart: number | null;
  workEnd: number | null;
  dinner: Interval | null;
}

const MIN_SEGMENT = 15;

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .map(i => ({ start: Math.max(0, i.start), end: Math.min(1440, i.end) }))
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

// The pure core.
export function computeFreeDay(
  windows: DayWindows,
  busy: Interval[],
  nowMin: number | null = null,
): Interval[] {
  const blocked: Interval[] = [];
  // Sleep: wraps midnight when start > end (23:30–07:30 blocks both edges).
  if (windows.sleepStart > windows.sleepEnd) {
    blocked.push({ start: 0, end: windows.sleepEnd }, { start: windows.sleepStart, end: 1440 });
  } else {
    blocked.push({ start: windows.sleepStart, end: windows.sleepEnd });
  }
  if (windows.workStart !== null && windows.workEnd !== null) {
    blocked.push({ start: windows.workStart, end: windows.workEnd });
  }
  if (windows.dinner) blocked.push(windows.dinner);
  blocked.push(...busy);

  const merged = mergeIntervals(blocked);
  const free: Interval[] = [];
  let cursor = 0;
  for (const b of merged) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < 1440) free.push({ start: cursor, end: 1440 });

  return free
    .map(s => (nowMin !== null && s.start < nowMin ? { start: nowMin, end: s.end } : s))
    .filter(s => s.end - s.start >= MIN_SEGMENT);
}

// Config windows for a date, with that day's anchor taps overriding the edges
// (latest tap per kind wins): wake_up → sleepEnd, sleep → sleepStart,
// start_work/end_work → work edges.
export function effectiveWindows(dateStr: string): DayWindows {
  const tz = getConfig<string>("TIMEZONE");
  const sleep = getConfig<{ start: string; end: string }>("SLEEP_WINDOW");
  const work = getConfig<{ start: string; end: string; days: number[] } | null>("WORK_WINDOW");
  const dinner = getConfig<{ start: string; end: string } | null>("DINNER_WINDOW");

  const isWorkday = work ? work.days.includes(dayOfWeek(dateStr)) : false;
  const windows: DayWindows = {
    sleepStart: hhmmToMin(sleep.start),
    sleepEnd: hhmmToMin(sleep.end),
    workStart: isWorkday && work ? hhmmToMin(work.start) : null,
    workEnd: isWorkday && work ? hhmmToMin(work.end) : null,
    dinner: dinner ? { start: hhmmToMin(dinner.start), end: hhmmToMin(dinner.end) } : null,
  };

  const anchors = db
    .select()
    .from(anchorEvent)
    .where(eq(anchorEvent.date, dateStr))
    .orderBy(asc(anchorEvent.at))
    .all();
  for (const a of anchors) {
    const min = localMinutes(tz, new Date(a.at));
    if (a.kind === "wake_up") windows.sleepEnd = min;
    if (a.kind === "sleep") windows.sleepStart = min;
    if (a.kind === "start_work") windows.workStart = min;
    if (a.kind === "end_work") windows.workEnd = min;
  }
  return windows;
}

export interface FreeTimeDay {
  date: string;
  segments: { start: string; end: string; minutes: number }[];
  totalMinutes: number;
}

// Busy intervals come from the calendar layer (freebusy across ALL calendars);
// callers without a connected calendar pass []. Today is clamped to now.
export function freeTimeForDates(dates: string[], busyByDate: Map<string, Interval[]>): FreeTimeDay[] {
  const tz = getConfig<string>("TIMEZONE");
  const today = localDate(tz);
  return dates.map(date => {
    const nowMin = date === today ? localMinutes(tz) : null;
    const segments = computeFreeDay(effectiveWindows(date), busyByDate.get(date) ?? [], nowMin);
    return {
      date,
      segments: segments.map(s => ({
        start: minToHhmm(s.start),
        end: minToHhmm(s.end),
        minutes: s.end - s.start,
      })),
      totalMinutes: segments.reduce((sum, s) => sum + (s.end - s.start), 0),
    };
  });
}

export function upcomingDates(days: number): string[] {
  const tz = getConfig<string>("TIMEZONE");
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(localDate(tz, new Date(Date.now() + i * 86_400_000)));
  }
  return out;
}

// Human-readable report for the schedule agent and prompt generator.
export function renderFreeTimeReport(days: FreeTimeDay[], note?: string): string {
  const lines = days.map(
    d =>
      `- ${d.date}: ${
        d.segments.length
          ? d.segments.map(s => `${s.start}–${s.end} (${s.minutes}m)`).join(", ")
          : "no free segments"
      } — total ${Math.round(d.totalMinutes / 6) / 10}h`,
  );
  return `${note ? `${note}\n\n` : ""}${lines.join("\n")}`;
}
