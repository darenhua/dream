import { Hono } from "hono";
import { getAllConfig, setConfig } from "../../services/config";

export const configRoutes = new Hono();

configRoutes.get("/", c => c.json(getAllConfig()));

// Body is a partial {key: value} map; values stored as-is (JSON).
configRoutes.patch("/", async c => {
  const body = (await c.req.json()) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) setConfig(key, value);
  return c.json(getAllConfig());
});
