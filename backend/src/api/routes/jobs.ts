import { Hono } from "hono";
import { runHeartbeat } from "../../services/daily";

export const jobRoutes = new Hono();

// "/daily" kept as an alias so existing dashboard/admin callers don't break.
jobRoutes.post("/heartbeat", async c => {
  return c.json(await runHeartbeat("manual"));
});

jobRoutes.post("/daily", async c => {
  return c.json(await runHeartbeat("manual"));
});
