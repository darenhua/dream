import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
  conversation,
  environmentItem,
  extraction,
  extractionLink,
  goal,
  goalEnvironment,
  goalEvidence,
  goalHabit,
  habit,
} from "../../db/schema";
import { attemptCounts, createGoal, listGoals, reorderGoals, setGoalStatus } from "../../services/goals";

export const goalRoutes = new Hono();

goalRoutes.get("/", c => {
  const { status } = c.req.query();
  const attempts = attemptCounts();
  const habitLinks = db
    .select({ goalId: goalHabit.goalId, id: habit.id, title: habit.title, status: habit.status })
    .from(goalHabit)
    .innerJoin(habit, eq(goalHabit.habitId, habit.id))
    .all();
  const envLinks = db
    .select({
      goalId: goalEnvironment.goalId,
      id: environmentItem.id,
      title: environmentItem.title,
      subKind: environmentItem.subKind,
    })
    .from(goalEnvironment)
    .innerJoin(environmentItem, eq(goalEnvironment.environmentItemId, environmentItem.id))
    .all();
  return c.json(
    listGoals(status || undefined).map(g => ({
      ...g,
      attemptCount: attempts.get(g.id) ?? 0, // the heatmap signal
      habits: habitLinks.filter(l => l.goalId === g.id).map(({ goalId, ...h }) => h),
      environmentItems: envLinks.filter(l => l.goalId === g.id).map(({ goalId, ...e }) => e),
    })),
  );
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
  // The provenance trail: every extraction that ever fed this goal.
  const linkedIds = db
    .select({ extractionId: extractionLink.extractionId })
    .from(extractionLink)
    .where(and(eq(extractionLink.entityType, "goal"), eq(extractionLink.entityId, row.id)))
    .all()
    .map(r => r.extractionId);
  const extractions = linkedIds.length
    ? db.select().from(extraction).where(inArray(extraction.id, linkedIds)).all()
    : [];
  return c.json({ ...row, attemptCount: attemptCounts().get(row.id) ?? 0, evidence, extractions });
});

// Manual create — origin: manual.
goalRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.title) return c.json({ error: "title required" }, 400);
  const { goal: created, note } = createGoal({
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
