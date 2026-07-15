import { Hono } from "hono";
import {
  approveReview,
  finishInterview,
  generateDraft,
  getReview,
  patchDraft,
  startInterview,
} from "../../services/reviewWriteup";

export const reviewRoutes = new Hono();

reviewRoutes.get("/:experimentId", c => {
  const row = getReview(c.req.param("experimentId"));
  if (!row) return c.json({ error: "no review yet" }, 404);
  return c.json(row);
});

reviewRoutes.post("/:experimentId/generate", async c => {
  try {
    return c.json(await generateDraft(c.req.param("experimentId"), "manual"));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

reviewRoutes.patch("/:experimentId", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.draftMd !== "string") return c.json({ error: "draftMd required" }, 400);
  const row = patchDraft(c.req.param("experimentId"), body.draftMd);
  if (!row) return c.json({ error: "no editable draft (missing or already approved)" }, 400);
  return c.json(row);
});

reviewRoutes.post("/:experimentId/approve", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.finalMd !== "string" || !body.finalMd.trim()) {
    return c.json({ error: "finalMd required" }, 400);
  }
  try {
    return c.json(await approveReview(c.req.param("experimentId"), body.finalMd));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

reviewRoutes.post("/:experimentId/interview", c => {
  return c.json(startInterview(c.req.param("experimentId")));
});

reviewRoutes.post("/interview/:sessionId/finish", async c => {
  try {
    return c.json(await finishInterview(c.req.param("sessionId")));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
