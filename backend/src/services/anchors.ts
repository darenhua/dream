import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { anchorEvent, calendarEvent } from "../db/schema";
import { localDate, localMinutes, minToHhmm, zonedIso } from "../lib/time";
import { getConfig } from "./config";
import { emit } from "./events";
import { isConnected, busyByDate, ensureDreamCalendar, syncIfStale } from "./calendarSync";
import { gcal } from "./google/calendar";
import { computeFreeDay, effectiveWindows, type Interval } from "./freeTime";

type AnchorKind = typeof anchorEvent.$inferSelect.kind;

export interface RescheduleDiff {
  moved: { title: string; from: string; to: string }[];
  unplaced: { title: string }[];
}

// One tap: timestamp the anchor (it overrides today's windows and doubles as
// the habit-tracking signal), then blame-freely re-place today's remaining
// dream blocks into the recomputed free time. Deterministic — no agent call.
export async function tapAnchor(kind: AnchorKind): Promise<{ anchor: typeof anchorEvent.$inferSelect; reschedule: RescheduleDiff | null }> {
  const tz = getConfig<string>("TIMEZONE");
  const date = localDate(tz);
  const anchor = db
    .insert(anchorEvent)
    .values({ kind, date, at: new Date().toISOString() })
    .returning()
    .get();
  emit("anchor", anchor.id, "anchor_tapped", { kind, date });

  let reschedule: RescheduleDiff | null = null;
  if (isConnected()) {
    try {
      reschedule = await rescheduleToday();
    } catch (e) {
      // The tap must never fail because Google hiccuped.
      emit("anchor", anchor.id, "reschedule_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { anchor, reschedule };
}

export function anchorsForDate(date: string) {
  return db.select().from(anchorEvent).where(eq(anchorEvent.date, date)).orderBy(asc(anchorEvent.at)).all();
}

interface TodayInstance {
  gcalEventId: string;
  localRowId: string | null;
  title: string;
  startMin: number;
  endMin: number;
  recurring: boolean;
}

// Today's remaining dream-calendar instances, server-side expanded
// (singleEvents=true) so RRULEs are never expanded locally.
async function todaysRemainingInstances(tz: string, date: string, nowMin: number): Promise<TodayInstance[]> {
  const calendarId = await ensureDreamCalendar();
  const page = await gcal.listEvents(calendarId, {
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: zonedIso(tz, date, nowMin),
    timeMax: zonedIso(tz, date, 1440),
  });
  const out: TodayInstance[] = [];
  for (const g of page.items) {
    if (g.status === "cancelled" || !g.start?.dateTime || !g.end?.dateTime) continue;
    const startMin = localMinutes(tz, new Date(g.start.dateTime));
    const endMin = localMinutes(tz, new Date(g.end.dateTime));
    if (localDate(tz, new Date(g.start.dateTime)) !== date) continue;
    const masterId = g.recurringEventId ?? g.id;
    const local = db.select().from(calendarEvent).where(eq(calendarEvent.gcalEventId, masterId)).get();
    out.push({
      gcalEventId: g.id,
      localRowId: local?.id ?? null,
      title: g.summary ?? "(untitled)",
      startMin,
      endMin: endMin > startMin ? endMin : startMin + 30,
      recurring: Boolean(g.recurringEventId || g.recurrence),
    });
  }
  return out;
}

function subtractInterval(busy: Interval[], remove: Interval): Interval[] {
  const out: Interval[] = [];
  for (const b of busy) {
    if (remove.end <= b.start || remove.start >= b.end) {
      out.push(b);
      continue;
    }
    if (remove.start > b.start) out.push({ start: b.start, end: remove.start });
    if (remove.end < b.end) out.push({ start: remove.end, end: b.end });
  }
  return out;
}

export async function rescheduleToday(): Promise<RescheduleDiff> {
  const tz = getConfig<string>("TIMEZONE");
  const date = localDate(tz);
  const nowMin = localMinutes(tz);

  await syncIfStale();
  const instances = await todaysRemainingInstances(tz, date, nowMin);
  const diff: RescheduleDiff = { moved: [], unplaced: [] };
  if (!instances.length) return diff;

  // Busy across all calendars, minus the blocks we're about to move.
  let busy = (await busyByDate([date])).get(date) ?? [];
  for (const inst of instances) {
    busy = subtractInterval(busy, { start: inst.startMin, end: inst.endMin });
  }

  let free = computeFreeDay(effectiveWindows(date), busy, nowMin);
  const calendarId = await ensureDreamCalendar();

  // Greedy, chronological: durations preserved, earliest fitting segment wins.
  for (const inst of instances.sort((a, b) => a.startMin - b.startMin)) {
    const duration = inst.endMin - inst.startMin;
    const slot = free.find(s => s.end - s.start >= duration);
    if (!slot) {
      diff.unplaced.push({ title: inst.title });
      if (inst.localRowId) {
        db.update(calendarEvent)
          .set({ status: "needs_reschedule" })
          .where(eq(calendarEvent.id, inst.localRowId))
          .run();
      }
      continue;
    }
    const newStart = slot.start;
    const newEnd = newStart + duration;
    if (newStart !== inst.startMin) {
      // Patch the single instance (creates an exception for recurring blocks —
      // the one intentional exception-writer in the system).
      await gcal.patchEvent(calendarId, inst.gcalEventId, {
        start: { dateTime: zonedIso(tz, date, newStart), timeZone: tz },
        end: { dateTime: zonedIso(tz, date, newEnd), timeZone: tz },
      });
      if (inst.localRowId && !inst.recurring) {
        db.update(calendarEvent)
          .set({ startAt: zonedIso(tz, date, newStart), endAt: zonedIso(tz, date, newEnd) })
          .where(eq(calendarEvent.id, inst.localRowId))
          .run();
      }
      diff.moved.push({ title: inst.title, from: minToHhmm(inst.startMin), to: minToHhmm(newStart) });
    }
    // Claim the slot so the next block can't overlap it.
    free = subtractInterval(free, { start: newStart, end: newEnd }).filter(s => s.end - s.start >= 15);
  }

  emit("anchor", null, "rescheduled_today", diff);
  return diff;
}
