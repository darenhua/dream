import { count, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, wipeAllTables } from "../../db";
import { env, sideEffectsBlocked } from "../../lib/env";
import { conversation, environmentItem, event, experience, experiment, goal, habit, project } from "../../db/schema";
import { isConnected } from "../../services/calendarSync";
import { getConfig, seedConfig } from "../../services/config";
import { emit } from "../../services/events";
import { liveExperiment, listQueue } from "../../services/experiments";
import { ingestFile } from "../../services/ingestion";
import { authRow } from "../../services/google/auth";

export const adminRoutes = new Hono();

// The cycle checklist as JSON; all green = the loop is alive.
adminRoutes.get("/health", c => {
  const conversations = db.select({ n: count() }).from(conversation).get()?.n ?? 0;
  const activeGoals =
    db.select({ n: count() }).from(goal).where(eq(goal.status, "active")).get()?.n ?? 0;
  const registry = {
    habits:
      db.select({ n: count() }).from(habit).where(inArray(habit.status, ["established", "building"])).get()?.n ?? 0,
    environment:
      db.select({ n: count() }).from(environmentItem).where(eq(environmentItem.status, "active")).get()?.n ?? 0,
    experiences: db.select({ n: count() }).from(experience).get()?.n ?? 0,
    projects: db.select({ n: count() }).from(project).get()?.n ?? 0,
  };
  const live = liveExperiment();
  const lastDaily = db
    .select()
    .from(event)
    .where(eq(event.eventType, "daily_run_completed"))
    .orderBy(desc(event.createdAt))
    .limit(1)
    .get();

  return c.json({
    ok: true,
    env: env.APP_ENV,
    sha: env.GIT_SHA || null,
    sideEffectsBlocked: sideEffectsBlocked(),
    conversations,
    activeGoals,
    registry,
    experimentQueue: listQueue().length,
    liveExperimentId: live?.id ?? null,
    liveExperimentTitle: live?.title ?? null,
    calendarConnected: isConnected(),
    dreamCalendarId: authRow()?.dreamCalendarId ?? null,
    lastDailyRunAt: lastDaily?.createdAt ?? null,
  });
});

// §9 — multipart upload of the raw Claude conversations.json. Also accepts the
// array as a plain JSON body (curl / paste convenience).
adminRoutes.post("/import", async c => {
  let payload: unknown;
  try {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) {
        return c.json({ error: 'multipart import requires a "file" field' }, 400);
      }
      payload = JSON.parse(await file.text());
    } else {
      payload = await c.req.json();
    }
  } catch {
    return c.json({ error: "body is not valid JSON" }, 400);
  }

  try {
    const report = ingestFile(payload);
    return c.json(report);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Hard delete exists only here (N7). Emits after the wipe so the reset marker survives it.
adminRoutes.post("/reset", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== "RESET") {
    return c.json({ error: 'reset requires body {"confirm": "RESET"}' }, 400);
  }
  wipeAllTables();
  emit("admin", null, "reset");
  return c.json({ ok: true });
});

adminRoutes.post("/seed-config", async c => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(seedConfig(Boolean(body.overwrite)));
});
