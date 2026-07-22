import { and, isNull } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { calendarEvent } from "../db/schema";

// The consolidated calendar writer (Phase 7). All plan flows create their
// rows here. These rows are ASYNC WRITE JOBS for Google Calendar plus push
// bookkeeping ("was the calendar job done") — they are NEVER read as
// availability; Google Calendar is the source of truth and planners read it
// live through the user's calendar MCP. Pushing is best-effort, capped per
// run, never blocks a plan; the daily heartbeat retries stragglers.

export type ScheduledEventInput = {
  entityType: "habit" | "task" | "weekly_item" | "daily_adhoc" | "leisure";
  entityId: string;
  title: string;
  startAt: string;
  endAt: string;
  rrule?: string | null;
  blockStyle?: "habit" | "experiment" | "obligation" | "task";
};

export function createScheduledEvents(rows: ScheduledEventInput[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const inserted = db
      .insert(calendarEvent)
      .values({
        entityType: row.entityType,
        entityId: row.entityId,
        title: row.title,
        startAt: row.startAt,
        endAt: row.endAt,
        rrule: row.rrule ?? null,
        blockStyle: row.blockStyle ?? "task",
      })
      .returning({ id: calendarEvent.id })
      .get();
    ids.push(inserted.id);
  }
  return ids;
}

/** Push not-yet-pushed rows to GCal. Capped per run (quota kindness); a
 * failure stamps push_failed_at + error and is skipped until retried
 * explicitly. No-op without a calendar connection. */
export async function pushPendingEvents(cap = 25): Promise<{ pushed: number; failed: number; skipped: string }> {
  const { isConnected, pushEvent } = await import("./calendarSync");
  if (!isConnected()) return { pushed: 0, failed: 0, skipped: "google calendar not connected" };
  const pending = db
    .select()
    .from(calendarEvent)
    .where(and(isNull(calendarEvent.gcalEventId), isNull(calendarEvent.pushFailedAt), eq(calendarEvent.status, "active")))
    .limit(cap)
    .all();
  let pushed = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      await pushEvent(row.id);
      db.update(calendarEvent).set({ pushedAt: new Date().toISOString() }).where(eq(calendarEvent.id, row.id)).run();
      pushed++;
    } catch (e) {
      db.update(calendarEvent)
        .set({ pushFailedAt: new Date().toISOString(), pushError: e instanceof Error ? e.message : String(e) })
        .where(eq(calendarEvent.id, row.id))
        .run();
      failed++;
    }
  }
  return { pushed, failed, skipped: "" };
}
