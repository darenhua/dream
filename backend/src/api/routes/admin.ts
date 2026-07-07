import { count, desc, eq, isNull, and } from "drizzle-orm";
import { Hono } from "hono";
import { db, wipeAllTables } from "../../db";
import { category, conversation, event, goal, registryItem } from "../../db/schema";
import { seedConfig } from "../../services/config";
import { emit } from "../../services/events";
import { liveExperiment } from "../../services/experiments";
import { ingestFile } from "../../services/ingestion";
import { pendingCategorizations } from "../../services/categorize";
import { listProposals } from "../../services/proposals";

export const adminRoutes = new Hono();

// §9/§11 — the cycle checklist as JSON; all green = the cycle is alive.
adminRoutes.get("/health", c => {
  const conversations = db.select({ n: count() }).from(conversation).get()?.n ?? 0;
  const sluggedUnprocessed = pendingCategorizations().length;
  const activeCategories =
    db.select({ n: count() }).from(category).where(eq(category.status, "active")).get()?.n ?? 0;
  const activeGoals =
    db.select({ n: count() }).from(goal).where(eq(goal.status, "active")).get()?.n ?? 0;
  const registry = {
    habits:
      db.select({ n: count() }).from(registryItem).where(and(eq(registryItem.kind, "habit"), eq(registryItem.status, "active"))).get()?.n ?? 0,
    environment:
      db.select({ n: count() }).from(registryItem).where(and(eq(registryItem.kind, "environment"), eq(registryItem.status, "active"))).get()?.n ?? 0,
    experiences:
      db.select({ n: count() }).from(registryItem).where(and(eq(registryItem.kind, "experience"), eq(registryItem.status, "active"))).get()?.n ?? 0,
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
    conversations,
    sluggedUnprocessed,
    activeCategories,
    activeGoals,
    pendingProposals: listProposals({ status: "pending" }).length,
    registry,
    liveExperimentId: live?.id ?? null,
    liveExperimentTitle: live?.title ?? null,
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
    return c.json(ingestFile(payload));
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
