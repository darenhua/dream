import { Hono } from "hono";
import { processPendingCategorizations } from "../../services/categorize";

export const jobRoutes = new Hono();

jobRoutes.post("/categorize", async c => {
  return c.json(await processPendingCategorizations("manual"));
});
