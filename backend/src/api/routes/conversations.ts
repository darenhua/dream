import { and, count, desc, like } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { conversation } from "../../db/schema";

export const conversationRoutes = new Hono();

const PAGE_SIZE = 50;

conversationRoutes.get("/", c => {
  const { q, page, pageSize } = c.req.query();
  const conds = [];
  if (q) conds.push(like(conversation.title, `%${q}%`));
  const where = conds.length ? and(...conds) : undefined;

  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(200, Math.max(1, Number(pageSize) || PAGE_SIZE));
  const total = db.select({ n: count() }).from(conversation).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(conversation)
    .where(where)
    .orderBy(desc(conversation.sourceUpdatedAt))
    .limit(size)
    .offset((pageNum - 1) * size)
    .all();

  const shaped = rows.map(row => {
    const { rawJson, contentJson, ...meta } = row;
    let messageCount: number | null = null;
    try {
      messageCount = contentJson ? (JSON.parse(contentJson) as unknown[]).length : null;
    } catch {}
    return { ...meta, messageCount };
  });

  return c.json({ page: pageNum, pageSize: size, total, conversations: shaped });
});

conversationRoutes.get("/:id", c => {
  const row = db.select().from(conversation).where(eq(conversation.id, c.req.param("id"))).get();
  if (!row) return c.json({ error: "conversation not found" }, 404);
  const { rawJson, contentJson, ...meta } = row;
  return c.json({
    ...meta,
    messages: contentJson ? JSON.parse(contentJson) : null,
  });
});
