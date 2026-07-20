import { Hono } from "hono";
import {
  archiveExperimentGroup,
  markExperimentGroupTarget,
  organizedDetailPayload,
  organizedFeed,
  restoreExperimentGroup,
} from "../../services/organized";

import { listWeeklyPlans, toggleGroupIdeaDone, toggleWeeklyItem, weeklyPlanContext } from "../../services/weeklyPlan";
import { latestPick } from "../../services/prioritize";

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

// Archive/restore are direct explicit user actions (not MCP draft operations):
// they only hide or unhide a noncurrent group and never change lineage, focus,
// ranks, sources, or history.
organizedRoutes.post("/groups/:id/archive", c => {
  try {
    return c.json(archiveExperimentGroup(c.req.param("id")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "archive failed";
    return c.json({ error: message }, message.includes("not found") ? 404 : 409);
  }
});

organizedRoutes.post("/groups/:id/restore", async c => {
  const body = await c.req.json().catch(() => ({}));
  const restoreAs = body.restoreAs;
  if (restoreAs !== undefined && !["candidate", "done", "sunset"].includes(restoreAs)) {
    return c.json({ error: "restoreAs must be candidate, done, or sunset" }, 400);
  }
  try {
    return c.json(restoreExperimentGroup(c.req.param("id"), restoreAs));
  } catch (error) {
    const message = error instanceof Error ? error.message : "restore failed";
    return c.json({ error: message }, message.includes("not found") ? 404 : 409);
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


// ── Rework: weekly plans + completion CRUD (the manual done toggles that
// double as the habit/momentum signal) ──────────────────────────────────────
organizedRoutes.get("/weekly", c => {
  const pick = latestPick();
  if (!pick) return c.json({ pick: null, plans: [] });
  return c.json({
    pick: { id: pick.pick.id, endDate: pick.pick.endDate, expired: pick.expired, groupLineageId: pick.groupLineageId },
    plans: listWeeklyPlans(pick.pick.id),
  });
});

organizedRoutes.get("/weekly/context", c => c.json(weeklyPlanContext()));

organizedRoutes.patch("/weekly/items/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  const row = toggleWeeklyItem(c.req.param("id"), Boolean(body.done));
  return row ? c.json(row) : c.json({ error: "item not found" }, 404);
});

organizedRoutes.patch("/group-ideas/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  const row = toggleGroupIdeaDone(c.req.param("id"), Boolean(body.done));
  return row ? c.json(row) : c.json({ error: "membership not found" }, 404);
});
