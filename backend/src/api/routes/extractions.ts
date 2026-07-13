import { Hono } from "hono";
import {
  addManualExtraction,
  deleteExtraction,
  FrozenExtractionError,
  getExtraction,
  listExtractions,
  patchExtraction,
} from "../../services/extractions";

export const extractionRoutes = new Hono();

extractionRoutes.get("/", c => {
  const { conversationId, kind, confirmed } = c.req.query();
  return c.json(
    listExtractions({
      conversationId: conversationId || undefined,
      kind: kind || undefined,
      confirmed: confirmed === "true" ? true : confirmed === "false" ? false : undefined,
    }),
  );
});

extractionRoutes.get("/:id", c => {
  const row = getExtraction(c.req.param("id"));
  if (!row) return c.json({ error: "extraction not found" }, 404);
  return c.json(row);
});

// Manual add during review — a passage the agent missed.
extractionRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.conversationId || !body.kind || !body.text) {
    return c.json({ error: "conversationId, kind, text required" }, 400);
  }
  try {
    return c.json(
      addManualExtraction({
        conversationId: body.conversationId,
        kind: body.kind,
        text: body.text,
        startIdx: body.startIdx ?? null,
        endIdx: body.endIdx ?? null,
      }),
      201,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

extractionRoutes.patch("/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = patchExtraction(c.req.param("id"), { text: body.text, kind: body.kind });
    if (!row) return c.json({ error: "extraction not found" }, 404);
    return c.json(row);
  } catch (e) {
    if (e instanceof FrozenExtractionError) return c.json({ error: e.message }, 409);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

extractionRoutes.delete("/:id", c => {
  try {
    const removed = deleteExtraction(c.req.param("id"));
    if (!removed) return c.json({ error: "extraction not found" }, 404);
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof FrozenExtractionError) return c.json({ error: e.message }, 409);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
