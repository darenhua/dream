import { Hono } from "hono";
import {
  archiveExperiment,
  currentExperiment,
  endExperiment,
  experimentHistory,
  getExperiment,
  listQueue,
  patchTask,
  pickExperiment,
  taskCopyPrompt,
} from "../../services/experiments";
import { generateExperimentPrompt } from "../../services/promptGenerator";
import { openingTurn } from "../../services/scheduleChat";

export const experimentRoutes = new Hono();

experimentRoutes.get("/queue", c => c.json(listQueue()));

experimentRoutes.get("/current", c => c.json({ experiment: currentExperiment() }));

experimentRoutes.get("/history", c => c.json(experimentHistory()));

// The prompt-generator output: paste into the Claude app, rant, import — the
// rant becomes the next candidate. The system never designs in-app.
experimentRoutes.get("/prompt", async c => {
  const result = await generateExperimentPrompt();
  if (!result.ok) return c.json({ error: result.error }, 502);
  return c.text(result.markdown, 200, { "content-type": "text/markdown; charset=utf-8" });
});

// Per-task copy-prompt for a fresh Claude thread.
experimentRoutes.get("/tasks/:taskId/copy-prompt", c => {
  const md = taskCopyPrompt(c.req.param("taskId"));
  if (md === null) return c.json({ error: "task not found" }, 404);
  return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
});

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

// queued → scheduling: opens the schedule-agent chat and runs its first turn.
experimentRoutes.post("/:id/pick", async c => {
  const result = pickExperiment(c.req.param("id"));
  if (!result.ok) return c.json(result, 409);
  const turn = await openingTurn(result.sessionId);
  return c.json({ ...result, openingTurn: turn });
});

// running → succeeded | failed. Blame-free; notes feed the next attempt.
experimentRoutes.post("/:id/end", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.verdict !== "succeeded" && body.verdict !== "failed") {
    return c.json({ error: 'verdict must be "succeeded" or "failed"' }, 400);
  }
  const result = endExperiment(c.req.param("id"), body.verdict, body.outcomeMd ?? body.outcome_md);
  return c.json(result, result.ok ? 200 : 400);
});

// queued → archived: the shame-free escape hatch.
experimentRoutes.post("/:id/archive", c => {
  const result = archiveExperiment(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});
