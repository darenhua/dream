import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { registryItem } from "../../db/schema";
import { emit } from "../../services/events";

export const registryRoutes = new Hono();

registryRoutes.get("/", c => {
  const { kind, status } = c.req.query();
  const conds = [];
  if (kind) conds.push(eq(registryItem.kind, kind as "habit" | "environment" | "experience"));
  if (status) conds.push(eq(registryItem.status, status as "proposed" | "active" | "removed"));
  return c.json(
    db
      .select()
      .from(registryItem)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(registryItem.createdAt))
      .all(),
  );
});

// Manual create — admin escape hatch (§9).
registryRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.kind || !body.title) return c.json({ error: "kind and title required" }, 400);
  const row = db
    .insert(registryItem)
    .values({
      kind: body.kind,
      title: body.title,
      note: body.note ?? null,
      valence: body.kind === "habit" ? (body.valence ?? null) : null,
      status: "active",
    })
    .returning()
    .get();
  emit("registry_item", row.id, "registry_item_created", { kind: row.kind, title: row.title });
  return c.json(row, 201);
});

registryRoutes.patch("/:id", async c => {
  const id = c.req.param("id");
  const existing = db.select().from(registryItem).where(eq(registryItem.id, id)).get();
  if (!existing) return c.json({ error: "registry item not found" }, 404);
  const body = await c.req.json().catch(() => ({}));

  if (body.status === "removed" && existing.kind === "experience") {
    return c.json({ error: "experiences are append-only (§7.6)" }, 400);
  }
  const patch: Partial<typeof registryItem.$inferInsert> = {};
  if (body.status !== undefined) patch.status = body.status;
  if (body.note !== undefined) patch.note = body.note;
  if (body.valence !== undefined && existing.kind === "habit") patch.valence = body.valence;

  const row = db.update(registryItem).set(patch).where(eq(registryItem.id, id)).returning().get();
  emit("registry_item", id, "registry_item_patched", patch);
  return c.json(row);
});
