import { Hono } from "hono";
import { runDaily } from "../../services/daily";
import { deriveConversation, derivePendingReviewed } from "../../services/derive";
import { distillPending } from "../../services/distill";
import { generateDaily, todayLocal } from "../../services/writeup";

export const jobRoutes = new Hono();

jobRoutes.post("/daily", async c => {
  return c.json(await runDaily("manual"));
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
