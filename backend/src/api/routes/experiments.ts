import { Hono } from "hono";
import {
  commitExperiment,
  createDraft,
  currentExperiment,
  endExperiment,
  experimentHistory,
  getPromptPackage,
} from "../../services/experiments";

export const experimentRoutes = new Hono();

experimentRoutes.get("/current", c => {
  const current = currentExperiment();
  if (!current) return c.json({ experiment: null });
  return c.json({ experiment: current });
});

experimentRoutes.get("/history", c => c.json(experimentHistory()));

experimentRoutes.get("/prompt-package", c => {
  const result = getPromptPackage();
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.text(result.markdown, 200, { "content-type": "text/markdown; charset=utf-8" });
});

experimentRoutes.post("/draft", async c => {
  let pasted: unknown;
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json({ error: "body must be JSON" }, 400);
  // Accept either the raw JSON object or {pastedJson: "..."} (string from a textarea).
  if (typeof body.pastedJson === "string") {
    try {
      pasted = JSON.parse(body.pastedJson);
    } catch {
      return c.json({ fieldErrors: { "(root)": ["pasted text is not valid JSON"] } }, 400);
    }
  } else {
    pasted = body.pastedJson ?? body;
  }
  const result = createDraft(pasted);
  if (!result.ok) return c.json({ fieldErrors: result.fieldErrors }, 400);
  return c.json(result.experiment, 201);
});

experimentRoutes.post("/:id/commit", c => {
  const result = commitExperiment(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});

experimentRoutes.post("/:id/end", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.verdict !== "done" && body.verdict !== "composted") {
    return c.json({ error: 'verdict must be "done" or "composted"' }, 400);
  }
  const result = endExperiment(c.req.param("id"), body.verdict, body.outcome_md, body.compost_why);
  return c.json(result, result.ok ? 200 : 400);
});
