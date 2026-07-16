import { Hono } from "hono";
import {
  closeExperimentGroup,
  markExperimentGroupTarget,
  organizedDetailPayload,
  organizedFeed,
  reorderOrganizedGoalPriority,
} from "../../services/organized";

export const organizedRoutes = new Hono();

// The new curated page reads a single coherent model. The legacy raw feed
// keeps using its existing endpoints and is intentionally untouched.
organizedRoutes.get("/feed", c => c.json(organizedFeed()));

organizedRoutes.post("/goals/priority", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.prioritizedIds) || !Array.isArray(body.outOfPriorityIds)) {
    return c.json({ error: "prioritizedIds[] and outOfPriorityIds[] required" }, 400);
  }
  const ok = reorderOrganizedGoalPriority(body.prioritizedIds, body.outOfPriorityIds);
  return ok ? c.json({ ok: true }) : c.json({ error: "lists must partition all active organized goals exactly once" }, 400);
});

organizedRoutes.post("/groups/:id/close", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.status !== "done" && body.status !== "sunset") return c.json({ error: "status must be done|sunset" }, 400);
  try {
    const row = closeExperimentGroup(c.req.param("id"), body.status, body.closingReviewMd);
    return row ? c.json(row) : c.json({ error: "experiment group not found" }, 404);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
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
