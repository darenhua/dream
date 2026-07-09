import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { calendarEvent } from "../../db/schema";
import { tapAnchor, anchorsForDate } from "../../services/anchors";
import { busyByDate, isConnected, syncIncremental } from "../../services/calendarSync";
import { authRow, consentUrl, disconnect, exchangeCode } from "../../services/google/auth";
import { getConfig } from "../../services/config";
import { freeTimeForDates, upcomingDates } from "../../services/freeTime";
import { localDate } from "../../lib/time";

export const calendarRoutes = new Hono();

// --- oauth ---

calendarRoutes.get("/auth/url", c => {
  try {
    return c.json({ url: consentUrl() });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Manual code-paste fallback (the loopback helper script is the happy path).
calendarRoutes.post("/auth/token", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.code) return c.json({ error: "code required" }, 400);
  try {
    return c.json(await exchangeCode(String(body.code).trim()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

calendarRoutes.post("/auth/disconnect", c => {
  disconnect();
  return c.json({ ok: true });
});

calendarRoutes.get("/status", c => {
  const row = authRow();
  return c.json({
    connected: row !== null,
    dreamCalendarId: row?.dreamCalendarId ?? null,
    hasSyncToken: Boolean(row?.syncToken),
  });
});

// --- sync + views ---

calendarRoutes.post("/sync", async c => {
  if (!isConnected()) return c.json({ error: "google calendar not connected" }, 400);
  try {
    return c.json(await syncIncremental());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// Today's schedule strip: the local mapping rows (blockStyle drives styling).
calendarRoutes.get("/today", c => {
  const tz = getConfig<string>("TIMEZONE");
  const today = localDate(tz);
  const rows = db
    .select()
    .from(calendarEvent)
    .where(eq(calendarEvent.status, "active"))
    .orderBy(desc(calendarEvent.startAt))
    .all()
    .filter(r => r.rrule !== null || r.startAt.slice(0, 10) === today);
  const needsReschedule = db
    .select()
    .from(calendarEvent)
    .where(eq(calendarEvent.status, "needs_reschedule"))
    .all();
  return c.json({ date: today, events: rows, needsReschedule, anchors: anchorsForDate(today) });
});

calendarRoutes.get("/free-time", async c => {
  const days = Math.min(14, Math.max(1, Number(c.req.query("days")) || 7));
  const dates = upcomingDates(days);
  try {
    const busy = isConnected() ? await busyByDate(dates) : new Map();
    return c.json({
      connected: isConnected(),
      days: freeTimeForDates(dates, busy),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// --- anchors ---

export const anchorRoutes = new Hono();

anchorRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!["wake_up", "start_work", "end_work", "sleep"].includes(body.kind)) {
    return c.json({ error: "kind must be wake_up|start_work|end_work|sleep" }, 400);
  }
  return c.json(await tapAnchor(body.kind));
});

anchorRoutes.get("/", c => {
  const tz = getConfig<string>("TIMEZONE");
  const date = c.req.query("date") || localDate(tz);
  return c.json(anchorsForDate(date));
});
