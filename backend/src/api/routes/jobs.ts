import { Hono } from "hono";
import { processPendingCategorizations } from "../../services/categorize";
import { deriveAll, deriveCategory } from "../../services/derive";

export const jobRoutes = new Hono();

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
