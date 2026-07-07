import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { conversation, goal, goalEvidence } from "../../db/schema";
import { createGoal, listGoals, reorderGoals, setGoalStatus } from "../../services/goals";

export const goalRoutes = new Hono();

goalRoutes.get("/", c => {
  const { status } = c.req.query();
  return c.json(listGoals(status || undefined));
});

goalRoutes.get("/:id", c => {
  const row = db.select().from(goal).where(eq(goal.id, c.req.param("id"))).get();
  if (!row) return c.json({ error: "goal not found" }, 404);
  const evidence = db
    .select({
      id: goalEvidence.id,
      conversationId: goalEvidence.conversationId,
      note: goalEvidence.note,
      createdAt: goalEvidence.createdAt,
      conversationTitle: conversation.title,
    })
    .from(goalEvidence)
    .leftJoin(conversation, eq(goalEvidence.conversationId, conversation.id))
    .where(eq(goalEvidence.goalId, row.id))
    .orderBy(desc(goalEvidence.createdAt))
    .all();
  return c.json({ ...row, evidence });
});

// Manual create — origin: manual (§9 admin).
goalRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.title) return c.json({ error: "title required" }, 400);
  const { goal: created, note } = createGoal({
    categoryId: body.categoryId ?? null,
    title: body.title,
    identityClause: body.identityClause ?? null,
    synthesisMd: body.synthesisMd ?? null,
    status: body.status ?? "active",
    origin: "manual",
  });
  return c.json({ goal: created, note }, 201);
});

goalRoutes.patch("/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.status) return c.json({ error: "status required" }, 400);
  const result = setGoalStatus(c.req.param("id"), body.status);
  if (!result) return c.json({ error: "goal not found" }, 404);
  return c.json(result);
});

goalRoutes.post("/reorder", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.orderedIds)) return c.json({ error: "orderedIds[] required" }, 400);
  const ok = reorderGoals(body.orderedIds);
  if (!ok) return c.json({ error: "orderedIds must be exactly the set of active goal ids" }, 400);
  return c.json({ ok: true });
});
