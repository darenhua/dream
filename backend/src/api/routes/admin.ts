import { Hono } from "hono";
import { wipeAllTables } from "../../db";
import { seedConfig } from "../../services/config";
import { emit } from "../../services/events";

export const adminRoutes = new Hono();

// Hard delete exists only here (N7). Emits after the wipe so the reset marker survives it.
adminRoutes.post("/reset", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== "RESET") {
    return c.json({ error: 'reset requires body {"confirm": "RESET"}' }, 400);
  }
  wipeAllTables();
  emit("admin", null, "reset");
  return c.json({ ok: true });
});

adminRoutes.post("/seed-config", async c => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(seedConfig(Boolean(body.overwrite)));
});
