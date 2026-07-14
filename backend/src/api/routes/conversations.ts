import { and, desc, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { conversation } from "../../db/schema";
import { deriveConversation, rederiveConversation } from "../../services/derive";
import { distillPending, redistill } from "../../services/distill";
import { confirmExtractions, listExtractions } from "../../services/extractions";
import { pipelineState } from "../../services/pipeline";
import { acceptRant, rejectRant } from "../../services/rantDetection";

export const conversationRoutes = new Hono();

const PAGE_SIZE = 50;

conversationRoutes.get("/", c => {
  const { slugged, state, q, page, rant } = c.req.query();
  const conds = [];
  if (slugged === "true") conds.push(eq(conversation.slugDetected, true));
  if (slugged === "false") conds.push(eq(conversation.slugDetected, false));
  // Direct column filter (not the post-page FSM filter) so the candidates
  // gate sees every proposed rant, not just the newest page.
  if (rant === "proposed" || rant === "accepted" || rant === "rejected") {
    conds.push(eq(conversation.rantStatus, rant));
  }
  if (q) conds.push(like(conversation.title, `%${q}%`));

  const pageNum = Math.max(1, Number(page) || 1);
  const rows = db
    .select()
    .from(conversation)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(conversation.sourceUpdatedAt))
    .limit(PAGE_SIZE)
    .offset((pageNum - 1) * PAGE_SIZE)
    .all();

  const shaped = rows
    .map(row => {
      const { rawJson, contentJson, ...meta } = row;
      return { ...meta, pipelineState: pipelineState(row) };
    })
    .filter(row => !state || row.pipelineState === state);

  return c.json({ page: pageNum, pageSize: PAGE_SIZE, conversations: shaped });
});

conversationRoutes.get("/:id", c => {
  const row = db.select().from(conversation).where(eq(conversation.id, c.req.param("id"))).get();
  if (!row) return c.json({ error: "conversation not found" }, 404);
  const { rawJson, contentJson, ...meta } = row;
  return c.json({
    ...meta,
    pipelineState: pipelineState(row),
    messages: contentJson ? JSON.parse(contentJson) : null,
    extractions: listExtractions({ conversationId: row.id }),
  });
});

// Intake gate: human accepts a detected candidate (or force-admits anything
// with content) — this is what actually starts distill.
conversationRoutes.post("/:id/rant-accept", async c => {
  const id = c.req.param("id");
  try {
    acceptRant(id);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  // Distill right away — the read-back gate should fill without waiting.
  const result = await distillPending("manual");
  return c.json({ ok: true, distill: result });
});

conversationRoutes.post("/:id/rant-reject", async c => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    rejectRant(id, body.note);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Legacy alias for the pre-gate "manual add" flow — same thing as accepting.
conversationRoutes.post("/:id/request-distill", async c => {
  const id = c.req.param("id");
  try {
    acceptRant(id);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const result = await distillPending("manual");
  return c.json({ ok: true, distill: result });
});

// Human gate #1: freeze the extraction set, then kick derive.
conversationRoutes.post("/:id/confirm-extractions", async c => {
  const id = c.req.param("id");
  try {
    const result = confirmExtractions(id);
    const derive = await deriveConversation(id, "manual").catch(e => ({
      status: "failed" as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    return c.json({ ok: true, ...result, derive });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Admin: re-distill (appends extractions, reopens review + derive).
conversationRoutes.post("/:id/redistill", async c => {
  try {
    return c.json(await redistill(c.req.param("id")));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Admin: re-derive (supersedes this conversation's pending proposals).
conversationRoutes.post("/:id/rederive", async c => {
  try {
    return c.json(await rederiveConversation(c.req.param("id")));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
