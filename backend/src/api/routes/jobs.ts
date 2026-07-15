import { Hono } from "hono";
import { runHeartbeat } from "../../services/daily";
import { deriveConversation, derivePendingReviewed } from "../../services/derive";
import { distillPending } from "../../services/distill";
import { generateDaily, todayLocal } from "../../services/writeup";

export const jobRoutes = new Hono();

// "/daily" kept as an alias so existing dashboard/admin callers don't break.
jobRoutes.post("/heartbeat", async c => {
  return c.json(await runHeartbeat("manual"));
});

jobRoutes.post("/daily", async c => {
  return c.json(await runHeartbeat("manual"));
});

// Optional {limit: N} = the explorer's pacing valve for bulk backlogs:
// classify only the N oldest-undetected conversations this call.
jobRoutes.post("/detect", async c => {
  const body = await c.req.json().catch(() => ({}));
  const { detectPendingRants } = await import("../../services/rantDetection");
  const limit = Number(body.limit);
  return c.json(await detectPendingRants("manual", Number.isFinite(limit) && limit > 0 ? limit : undefined));
});

jobRoutes.post("/distill", async c => {
  return c.json(await distillPending("manual"));
});

jobRoutes.post("/derive", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.conversationId) {
    try {
      return c.json(await deriveConversation(body.conversationId, "manual"));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  return c.json(await derivePendingReviewed("manual"));
});

jobRoutes.post("/writeup", async c => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await generateDaily(body.date ?? todayLocal(), "manual"));
});
