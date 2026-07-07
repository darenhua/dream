import { Hono } from "hono";
import { wipeAllTables } from "../../db";
import { seedConfig } from "../../services/config";
import { emit } from "../../services/events";
import { ingestFile } from "../../services/ingestion";

export const adminRoutes = new Hono();

// §9 — multipart upload of the raw Claude conversations.json. Also accepts the
// array as a plain JSON body (curl / paste convenience).
adminRoutes.post("/import", async c => {
  let payload: unknown;
  try {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) {
        return c.json({ error: 'multipart import requires a "file" field' }, 400);
      }
      payload = JSON.parse(await file.text());
    } else {
      payload = await c.req.json();
    }
  } catch {
    return c.json({ error: "body is not valid JSON" }, 400);
  }

  try {
    return c.json(ingestFile(payload));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

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
