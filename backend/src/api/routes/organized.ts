import { Hono } from "hono";
import {
  markExperimentGroupTarget,
  organizedDetailPayload,
  organizedFeed,
} from "../../services/organized";

export const organizedRoutes = new Hono();

// The new curated page reads a single coherent model. The legacy raw feed
// keeps using its existing endpoints and is intentionally untouched.
organizedRoutes.get("/feed", c => c.json(organizedFeed()));

organizedRoutes.post("/goals/priority", c => {
  // Focus is a durable reviewed decision, not a rearrangeable dashboard list.
  // Kept as a clear migration response for older dashboard clients.
  return c.json({ error: "open a reviewed prioritize workspace to change the current focus" }, 409);
});

organizedRoutes.post("/groups/:id/close", c => {
  // A close/sunset may also select the next focus, so it must stay within the
  // one atomic dashboard-reviewed prioritize change set.
  return c.json({ error: "open a sunset prioritize workspace to close the current focus" }, 409);
});

organizedRoutes.post("/groups/:groupId/targets/:targetId", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.done !== "boolean") return c.json({ error: "done boolean required" }, 400);
  const row = markExperimentGroupTarget(c.req.param("groupId"), c.req.param("targetId"), body.done);
  return row ? c.json(row) : c.json({ error: "experiment group target not found" }, 404);
});

organizedRoutes.get("/:type/:id", c => {
  const type = c.req.param("type");
  if (!["organized_goal", "organized_habit", "organized_environment", "experiment_group", "actionable_experiment"].includes(type)) {
    return c.json({ error: "unknown organized entity type" }, 400);
  }
  const detail = organizedDetailPayload(
    type as "organized_goal" | "organized_habit" | "organized_environment" | "experiment_group" | "actionable_experiment",
    c.req.param("id"),
  );
  return detail ? c.json(detail) : c.json({ error: "organized entity not found" }, 404);
});
