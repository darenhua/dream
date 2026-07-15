import { Hono } from "hono";
import { cancelSteer, finishSteer, startSteer, type SteerTarget } from "../../services/steering";

// The universal EDIT next to accept/deny: start a steer chat anchored to a
// generation, converse over the L3 stream route, finish to redo-in-place.
export const steeringRoutes = new Hono();

steeringRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  const targetType = body.targetType as SteerTarget;
  if (!["distill", "proposal", "goal"].includes(targetType) || typeof body.targetId !== "string") {
    return c.json({ error: "targetType (distill|proposal|goal) and targetId required" }, 400);
  }
  try {
    return c.json(startSteer(targetType, body.targetId));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

steeringRoutes.post("/:sessionId/finish", async c => {
  try {
    return c.json(await finishSteer(c.req.param("sessionId")));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

steeringRoutes.post("/:sessionId/cancel", c => {
  if (!cancelSteer(c.req.param("sessionId"))) return c.json({ error: "not an open session" }, 400);
  return c.json({ ok: true });
});
