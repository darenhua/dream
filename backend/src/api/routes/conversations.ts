import { and, desc, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { conversation } from "../../db/schema";
import { deriveConversation, rederiveConversation } from "../../services/derive";
import { distillPending, redistill } from "../../services/distill";
import { emit } from "../../services/events";
import { confirmExtractions, listExtractions } from "../../services/extractions";
import { pipelineState } from "../../services/pipeline";

export const conversationRoutes = new Hono();

const PAGE_SIZE = 50;

conversationRoutes.get("/", c => {
  const { slugged, state, q, page } = c.req.query();
  const conds = [];
  if (slugged === "true") conds.push(eq(conversation.slugDetected, true));
  if (slugged === "false") conds.push(eq(conversation.slugDetected, false));
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

// Manual add: send an un-slugged conversation (historical backlog) through
// the distill pipeline.
conversationRoutes.post("/:id/request-distill", async c => {
  const id = c.req.param("id");
  const row = db.select().from(conversation).where(eq(conversation.id, id)).get();
  if (!row) return c.json({ error: "conversation not found" }, 404);
  if (!row.contentJson) return c.json({ error: "conversation has no parsed content" }, 400);
  db.update(conversation).set({ distillRequested: true }).where(eq(conversation.id, id)).run();
  emit("conversation", id, "distill_requested", {});
  // Distill right away — the read-back gate should fill without waiting for cron.
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
