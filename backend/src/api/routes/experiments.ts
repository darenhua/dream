import { Hono } from "hono";
import {
  archiveExperiment,
  confirmActionableSchedule,
  currentExperiment,
  endExperiment,
  experimentHistory,
  getExperiment,
  listQueue,
  patchTask,
} from "../../services/experiments";

export const experimentRoutes = new Hono();

experimentRoutes.get("/queue", c => c.json(listQueue()));

experimentRoutes.get("/current", c => c.json({ experiment: currentExperiment() }));

experimentRoutes.get("/history", c => c.json(experimentHistory()));

// Weekly authoring now happens in a user-opened MCP collaboration workspace.
// There is deliberately no experiment-idea capture endpoint on this route.

experimentRoutes.patch("/tasks/:taskId", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!["pending", "scheduled", "done", "skipped"].includes(body.status)) {
    return c.json({ error: "status must be pending|scheduled|done|skipped" }, 400);
  }
  const row = patchTask(c.req.param("taskId"), body.status);
  if (!row) return c.json({ error: "task not found" }, 404);
  return c.json(row);
});

experimentRoutes.get("/:id", c => {
  const row = getExperiment(c.req.param("id"));
  if (!row) return c.json({ error: "experiment not found" }, 404);
  return c.json(row);
});

// A reviewed MCP-authored weekly actionable already has its task plan. This
// explicit confirmation is the only transition that creates its calendar rows;
// it does not open the legacy schedule chat or create duplicate task/habit rows.
experimentRoutes.post("/:id/confirm-schedule", async c => {
  const result = await confirmActionableSchedule(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 409);
});

// running → succeeded | failed. Blame-free; notes feed the next attempt.
// Ending triggers the review-writeup draft fire-and-forget — a failed draft
// never blocks the end, and the review screen has a regenerate button.
experimentRoutes.post("/:id/end", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.verdict !== "succeeded" && body.verdict !== "failed") {
    return c.json({ error: 'verdict must be "succeeded" or "failed"' }, 400);
  }
  const id = c.req.param("id");
  const result = endExperiment(id, body.verdict, body.outcomeMd ?? body.outcome_md);
  return c.json(result, result.ok ? 200 : 400);
});

// queued → archived: the shame-free escape hatch.
experimentRoutes.post("/:id/archive", c => {
  const result = archiveExperiment(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});
