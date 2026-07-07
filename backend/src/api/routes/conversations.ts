import { and, desc, eq, exists, like, not, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { category, conversation, rantLink } from "../../db/schema";
import { emit } from "../../services/events";
import { createLink, deleteLink } from "../../services/rantLinks";

export const conversationRoutes = new Hono();

const PAGE_SIZE = 50;

function linksFor(conversationId: string) {
  return db
    .select({
      id: rantLink.id,
      categoryId: rantLink.categoryId,
      categoryName: category.name,
      activeForDerive: rantLink.activeForDerive,
      pinned: rantLink.pinned,
      source: rantLink.source,
    })
    .from(rantLink)
    .innerJoin(category, eq(rantLink.categoryId, category.id))
    .where(eq(rantLink.conversationId, conversationId))
    .all();
}

conversationRoutes.get("/", c => {
  const { slugged, categorized, q, page } = c.req.query();
  const conds = [];
  if (slugged === "true") conds.push(eq(conversation.slugDetected, true));
  if (slugged === "false") conds.push(eq(conversation.slugDetected, false));
  const hasLink = exists(
    db.select({ one: sql`1` }).from(rantLink).where(eq(rantLink.conversationId, conversation.id)),
  );
  if (categorized === "true") conds.push(hasLink);
  if (categorized === "false") conds.push(not(hasLink));
  if (q) conds.push(like(conversation.title, `%${q}%`));

  const pageNum = Math.max(1, Number(page) || 1);
  const rows = db
    .select({
      id: conversation.id,
      title: conversation.title,
      source: conversation.source,
      sourceCreatedAt: conversation.sourceCreatedAt,
      sourceUpdatedAt: conversation.sourceUpdatedAt,
      slugDetected: conversation.slugDetected,
      categorizeProcessedAt: conversation.categorizeProcessedAt,
      parseError: conversation.parseError,
    })
    .from(conversation)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(conversation.sourceUpdatedAt))
    .limit(PAGE_SIZE)
    .offset((pageNum - 1) * PAGE_SIZE)
    .all();

  return c.json({
    page: pageNum,
    pageSize: PAGE_SIZE,
    conversations: rows.map(row => ({ ...row, links: linksFor(row.id) })),
  });
});

conversationRoutes.get("/:id", c => {
  const row = db
    .select()
    .from(conversation)
    .where(eq(conversation.id, c.req.param("id")))
    .get();
  if (!row) return c.json({ error: "conversation not found" }, 404);
  const { rawJson, contentJson, ...meta } = row;
  return c.json({
    ...meta,
    messages: contentJson ? JSON.parse(contentJson) : null,
    links: linksFor(row.id),
  });
});

conversationRoutes.post("/:id/links", async c => {
  const conversationId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  if (!body.categoryId) return c.json({ error: "categoryId required" }, 400);
  const convo = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .get();
  if (!convo) return c.json({ error: "conversation not found" }, 404);
  const cat = db.select().from(category).where(eq(category.id, body.categoryId)).get();
  if (!cat) return c.json({ error: "category not found" }, 404);
  const { link, created } = createLink(conversationId, body.categoryId, "manual");
  return c.json({ link, created }, created ? 201 : 200);
});

conversationRoutes.delete("/:id/links/:categoryId", c => {
  const removed = deleteLink(c.req.param("id"), c.req.param("categoryId"));
  if (!removed) return c.json({ error: "link not found" }, 404);
  return c.json({ ok: true });
});

// §7.1 — admin affordance to force re-categorization.
conversationRoutes.post("/:id/reset-categorization", c => {
  const id = c.req.param("id");
  const row = db.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, id)).get();
  if (!row) return c.json({ error: "conversation not found" }, 404);
  db.update(conversation).set({ categorizeProcessedAt: null }).where(eq(conversation.id, id)).run();
  emit("conversation", id, "categorization_reset");
  return c.json({ ok: true });
});
