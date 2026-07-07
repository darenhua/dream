import { Hono } from "hono";
import { processPendingCategorizations } from "../../services/categorize";
import { runDaily } from "../../services/daily";
import { deriveAll, deriveCategory } from "../../services/derive";
import { generateDaily, todayLocal } from "../../services/writeup";

export const jobRoutes = new Hono();

jobRoutes.post("/daily", async c => {
  return c.json(await runDaily("manual"));
});

jobRoutes.post("/writeup", async c => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await generateDaily(body.date ?? todayLocal(), "manual"));
});

jobRoutes.post("/categorize", async c => {
  return c.json(await processPendingCategorizations("manual"));
});

jobRoutes.post("/derive", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.categoryId) {
    try {
      return c.json(await deriveCategory(body.categoryId, "manual"));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  return c.json(await deriveAll("manual"));
});
