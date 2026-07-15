import { Hono } from "hono";
import { distillPending } from "../../services/distill";
import { cancelShaping, finishShaping, startShaping } from "../../services/shaping";

// Shape-the-next-experiment: an in-app L3 conversation that replaces the old
// copy-a-prompt-into-the-Claude-app loop. Finishing feeds the transcript into
// the normal rant pipeline as an already-accepted conversation.
export const shapingRoutes = new Hono();

shapingRoutes.post("/", c => {
  return c.json(startShaping());
});

shapingRoutes.post("/:sessionId/finish", async c => {
  try {
    const result = finishShaping(c.req.param("sessionId"));
    // Distill right away — the read-back gate fills before the user is back
    // on the feed (fire-and-forget; heartbeat sweeps any failure).
    distillPending("manual").catch(() => {});
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

shapingRoutes.post("/:sessionId/cancel", c => {
  if (!cancelShaping(c.req.param("sessionId"))) return c.json({ error: "not an open session" }, 400);
  return c.json({ ok: true });
});
