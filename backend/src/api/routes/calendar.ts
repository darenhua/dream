import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { calendarEvent } from "../../db/schema";
import { tapAnchor, anchorsForDate } from "../../services/anchors";
import { busyByDate, ensureDreamCalendar, isConnected, syncIncremental } from "../../services/calendarSync";
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

// The consent redirect lands here — the server completes the flow itself, so
// the admin panel's button is the whole story: open consent → approve → done.
calendarRoutes.get("/oauth/callback", async c => {
  const code = c.req.query("code");
  const err = c.req.query("error");
  const page = (title: string, body: string, status: 200 | 400 | 500 = 200) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h2>${title}</h2><p>${body}</p></body>`,
      status,
    );
  if (err) return page("consent failed", String(err), 400);
  if (!code) return page("consent failed", "no authorization code in the redirect", 400);
  try {
    await exchangeCode(code);
    const calendarId = await ensureDreamCalendar();
    return page(
      "dream is connected to google calendar",
      `dedicated calendar: <code>${calendarId}</code> — you can close this tab and head back to the dashboard.`,
    );
  } catch (e) {
    return page("token exchange failed", e instanceof Error ? e.message : String(e), 500);
  }
});

// Manual code-paste fallback for remote setups (VM) where the localhost
// redirect can't reach the server: copy the `code` param from the failed
// redirect URL and paste it into the admin panel.
calendarRoutes.post("/auth/token", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.code) return c.json({ error: "code required" }, 400);
  try {
    const result = await exchangeCode(String(body.code).trim());
    await ensureDreamCalendar();
    return c.json(result);
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
