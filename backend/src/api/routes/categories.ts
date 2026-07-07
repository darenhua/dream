import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { category } from "../../db/schema";
import { emit } from "../../services/events";
import { rebalanceCategory } from "../../services/rantLinks";

export const categoryRoutes = new Hono();

categoryRoutes.get("/", c => {
  const { status } = c.req.query();
  const rows = db
    .select()
    .from(category)
    .where(status ? eq(category.status, status as "active" | "archived") : undefined)
    .orderBy(asc(category.name))
    .all();
  return c.json(rows);
});

categoryRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || typeof body.name !== "string") return c.json({ error: "name required" }, 400);
  const existing = db.select().from(category).where(eq(category.name, body.name)).get();
  if (existing) return c.json({ error: `category "${body.name}" already exists` }, 409);
  const row = db
    .insert(category)
    .values({
      name: body.name,
      description: body.description ?? null,
      topKOverride: body.topKOverride ?? null,
    })
    .returning()
    .get();
  emit("category", row.id, "category_created", { name: row.name });
  return c.json(row, 201);
});

categoryRoutes.patch("/:id", async c => {
  const id = c.req.param("id");
  const existing = db.select().from(category).where(eq(category.id, id)).get();
  if (!existing) return c.json({ error: "category not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const patch: Partial<typeof category.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.status !== undefined) patch.status = body.status;
  if (body.topKOverride !== undefined) patch.topKOverride = body.topKOverride;
  const row = db.update(category).set(patch).where(eq(category.id, id)).returning().get();
  emit("category", id, "category_patched", patch);
  // A smaller top_k_override takes effect immediately.
  if (body.topKOverride !== undefined) rebalanceCategory(id);
  return c.json(row);
});
