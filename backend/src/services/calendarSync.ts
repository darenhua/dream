import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { calendarEvent, experience, experimentTask } from "../db/schema";
import { localDate, tzOffsetMinutes, zonedIso } from "../lib/time";
import { getConfig } from "./config";
import { emit } from "./events";
import { authRow, setDreamCalendarId, setSyncToken } from "./google/auth";
import { GoogleApiError, gcal, type GcalEvent } from "./google/calendar";
import type { Interval } from "./freeTime";

export { isConnected } from "./google/auth";

// Two-way sync with the dedicated "dream" calendar. Conflict policy for a
// single user: GCal wins for times (you drag, we follow), local wins for
// existence and metadata. Other calendars are read only via freebusy.

const DREAM_CALENDAR_NAME = "dream";

// blockStyle → GCal colorId: experiment blocks visually distinct from
// established-habit blocks (user requirement).
const COLOR_BY_STYLE: Record<string, string> = {
  habit: "10", // basil (green) — the established garden
  experiment: "6", // tangerine — the change being attempted
  obligation: "8", // graphite — non-negotiable
  task: "5", // banana — one-offs
};

export async function ensureDreamCalendar(): Promise<string> {
  const row = authRow();
  if (!row) throw new Error("google calendar not connected");
  if (row.dreamCalendarId) return row.dreamCalendarId;
  const list = await gcal.listCalendars();
  const existing = list.items.find(c => c.summary === DREAM_CALENDAR_NAME);
  const id = existing?.id ?? (await gcal.insertCalendar(DREAM_CALENDAR_NAME)).id;
  setDreamCalendarId(id);
  emit("google_auth", null, "dream_calendar_ready", { calendarId: id });
  return id;
}

type CalendarEventRow = typeof calendarEvent.$inferSelect;

function toGcalPayload(row: CalendarEventRow): Omit<GcalEvent, "id"> {
  const tz = getConfig<string>("TIMEZONE");
  return {
    summary: row.title,
    start: { dateTime: row.startAt, timeZone: tz },
    end: { dateTime: row.endAt, timeZone: tz },
    ...(row.rrule ? { recurrence: [`RRULE:${row.rrule}`] } : {}),
    colorId: COLOR_BY_STYLE[row.blockStyle],
    extendedProperties: {
      private: { dream_entity_type: row.entityType, dream_entity_id: row.entityId },
    },
  };
}

export async function pushEvent(rowId: string): Promise<CalendarEventRow> {
  const row = db.select().from(calendarEvent).where(eq(calendarEvent.id, rowId)).get();
  if (!row) throw new Error(`calendar_event ${rowId} not found`);
  const calendarId = await ensureDreamCalendar();
  const now = new Date().toISOString();
  if (row.gcalEventId) {
    await gcal.patchEvent(calendarId, row.gcalEventId, toGcalPayload(row));
    return db
      .update(calendarEvent)
      .set({ lastSyncedAt: now })
      .where(eq(calendarEvent.id, rowId))
      .returning()
      .get();
  }
  const created = await gcal.insertEvent(calendarId, toGcalPayload(row));
  return db
    .update(calendarEvent)
    .set({ gcalEventId: created.id, lastSyncedAt: now })
    .where(eq(calendarEvent.id, rowId))
    .returning()
    .get();
}

export async function cancelEvent(rowId: string) {
  const row = db.select().from(calendarEvent).where(eq(calendarEvent.id, rowId)).get();
  if (!row) return;
  if (row.gcalEventId) {
    const calendarId = await ensureDreamCalendar();
    try {
      await gcal.deleteEvent(calendarId, row.gcalEventId);
    } catch (e) {
      if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) throw e;
    }
  }
  db.update(calendarEvent).set({ status: "cancelled" }).where(eq(calendarEvent.id, rowId)).run();
}

// Inbound: the user dragged/deleted things in GCal. GCal wins for times.
function applyInbound(g: GcalEvent) {
  const entityId = g.extendedProperties?.private?.dream_entity_id;
  if (!entityId) return; // not ours (shouldn't happen on the dream calendar, but harmless)
  if (g.recurringEventId) {
    // Exception instance of a recurring block: the canonical schedule stays
    // the RRULE; log it and move on (only anchor-reschedule patches instances).
    emit("calendar_event", null, "recurring_exception_ignored", { gcalEventId: g.id });
    return;
  }
  const row = db.select().from(calendarEvent).where(eq(calendarEvent.gcalEventId, g.id)).get();
  if (!row) return;

  if (g.status === "cancelled") {
    db.update(calendarEvent).set({ status: "cancelled" }).where(eq(calendarEvent.id, row.id)).run();
    // A deleted task event returns the task to pending (user rejected the slot).
    if (row.entityType === "experiment_task") {
      db.update(experimentTask)
        .set({ status: "pending", scheduledFor: null })
        .where(eq(experimentTask.id, row.entityId))
        .run();
    }
    emit("calendar_event", row.id, "event_cancelled_in_gcal", {});
    return;
  }

  const startAt = g.start?.dateTime;
  const endAt = g.end?.dateTime;
  if (!startAt || !endAt) return;
  if (startAt === row.startAt && endAt === row.endAt) return;

  db.update(calendarEvent)
    .set({ startAt, endAt, lastSyncedAt: new Date().toISOString() })
    .where(eq(calendarEvent.id, row.id))
    .run();
  // Propagate the move to the owning entity.
  if (row.entityType === "experiment_task") {
    db.update(experimentTask).set({ scheduledFor: startAt }).where(eq(experimentTask.id, row.entityId)).run();
  }
  if (row.entityType === "experience") {
    db.update(experience).set({ plannedFor: startAt }).where(eq(experience.id, row.entityId)).run();
  }
  emit("calendar_event", row.id, "event_moved_in_gcal", { startAt, endAt });
}

export async function syncIncremental(): Promise<{ applied: number; fullResync: boolean }> {
  const row = authRow();
  if (!row) throw new Error("google calendar not connected");
  const calendarId = await ensureDreamCalendar();

  let applied = 0;
  let fullResync = false;
  let pageToken: string | undefined;
  let syncToken = row.syncToken ?? undefined;

  while (true) {
    let page;
    try {
      page = await gcal.listEvents(calendarId, {
        ...(pageToken ? { pageToken } : syncToken ? { syncToken } : { timeMin: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
      });
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 410 && syncToken) {
        // Expired sync token → drop it and full-resync from scratch.
        syncToken = undefined;
        setSyncToken(null);
        fullResync = true;
        pageToken = undefined;
        continue;
      }
      throw e;
    }
    for (const g of page.items) {
      applyInbound(g);
      applied++;
    }
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    if (page.nextSyncToken) setSyncToken(page.nextSyncToken);
    break;
  }

  db.update(calendarEvent)
    .set({ lastSyncedAt: new Date().toISOString() })
    .where(inArray(calendarEvent.status, ["active"]))
    .run();
  emit("google_auth", null, "calendar_synced", { applied, fullResync });
  return { applied, fullResync };
}

let lastSyncAt = 0;

// Throttled: called before every free-time computation so anchor-button mashing
// can't burn quota.
export async function syncIfStale() {
  const minInterval = getConfig<number>("GCAL_SYNC_MIN_INTERVAL_MIN") * 60_000;
  if (Date.now() - lastSyncAt < minInterval) return { skipped: true as const };
  lastSyncAt = Date.now();
  return syncIncremental();
}

// Busy intervals per local date across ALL calendars, for free-time math.
export async function busyByDate(dates: string[]): Promise<Map<string, Interval[]>> {
  const tz = getConfig<string>("TIMEZONE");
  const map = new Map<string, Interval[]>();
  if (!authRow()) return map;

  const timeMin = zonedIso(tz, dates[0]!, 0);
  const timeMax = zonedIso(tz, dates[dates.length - 1]!, 1440);
  const calendars = await gcal.listCalendars();
  const fb = await gcal.freebusy(timeMin, timeMax, calendars.items.map(c => c.id));

  for (const cal of Object.values(fb.calendars)) {
    for (const b of cal.busy) {
      splitBusyIntoDays(tz, b.start, b.end, map);
    }
  }
  return map;
}

// A busy span may cross midnight; attribute minutes to each local date it touches.
function splitBusyIntoDays(tz: string, startIso: string, endIso: string, map: Map<string, Interval[]>) {
  let cursor = new Date(startIso);
  const end = new Date(endIso);
  while (cursor < end) {
    const date = localDate(tz, cursor);
    const offset = tzOffsetMinutes(tz, cursor);
    const localMidnightUtcMs = Date.parse(`${date}T00:00:00Z`) - offset * 60_000;
    const startMin = Math.max(0, Math.round((cursor.getTime() - localMidnightUtcMs) / 60_000));
    const dayEndMs = localMidnightUtcMs + 1440 * 60_000;
    const segEndMs = Math.min(end.getTime(), dayEndMs);
    const endMin = Math.min(1440, Math.round((segEndMs - localMidnightUtcMs) / 60_000));
    if (endMin > startMin) {
      (map.get(date) ?? map.set(date, []).get(date)!).push({ start: startMin, end: endMin });
    }
    cursor = new Date(dayEndMs);
  }
}
