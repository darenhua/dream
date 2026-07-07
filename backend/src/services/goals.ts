import { asc, count, eq, max, sql } from "drizzle-orm";
import { db } from "../db";
import { goal } from "../db/schema";
import { getConfig } from "./config";
import { emit } from "./events";

export function activeGoalCount(): number {
  const row = db.select({ n: count() }).from(goal).where(eq(goal.status, "active")).get();
  return row?.n ?? 0;
}

function nextSortOrder(): number {
  const row = db
    .select({ m: max(goal.sortOrder) })
    .from(goal)
    .where(eq(goal.status, "active"))
    .get();
  return (row?.m ?? 0) + 1;
}

// Amendment 4: MAX_ACTIVE_GOALS gates ALL paths into `active` — overflow lands
// in backlog and the caller is told.
function capStatus(requested: string): { status: string; note?: string } {
  if (requested !== "active") return { status: requested };
  const cap = getConfig<number>("MAX_ACTIVE_GOALS");
  if (activeGoalCount() >= cap) {
    return {
      status: "backlog",
      note: `MAX_ACTIVE_GOALS (${cap}) reached — placed in backlog instead of active`,
    };
  }
  return { status: "active" };
}

export function createGoal(fields: {
  categoryId?: string | null;
  title: string;
  identityClause?: string | null;
  synthesisMd?: string | null;
  status?: "suggested" | "active" | "backlog" | "dormant" | "retired";
  origin: "derived" | "manual";
}): { goal: typeof goal.$inferSelect; note?: string } {
  const requested = fields.status ?? "active";
  const { status, note } = capStatus(requested);
  const row = db
    .insert(goal)
    .values({
      categoryId: fields.categoryId ?? null,
      title: fields.title,
      identityClause: fields.identityClause ?? null,
      synthesisMd: fields.synthesisMd ?? null,
      status: status as typeof goal.$inferInsert.status,
      sortOrder: status === "active" ? nextSortOrder() : 0,
      origin: fields.origin,
    })
    .returning()
    .get();
  emit("goal", row.id, "goal_created", { title: row.title, status: row.status, origin: row.origin });
  return { goal: row, note };
}

export function setGoalStatus(
  goalId: string,
  requested: "suggested" | "active" | "backlog" | "dormant" | "retired",
): { goal: typeof goal.$inferSelect; note?: string } | null {
  const existing = db.select().from(goal).where(eq(goal.id, goalId)).get();
  if (!existing) return null;
  const { status, note } = capStatus(requested);
  const row = db
    .update(goal)
    .set({
      status: status as typeof goal.$inferInsert.status,
      sortOrder: status === "active" ? nextSortOrder() : existing.sortOrder,
    })
    .where(eq(goal.id, goalId))
    .returning()
    .get();
  emit("goal", goalId, "goal_status_changed", { from: existing.status, to: status });
  return { goal: row, note };
}

// Reordering emits an event and asks nothing (§7.4 / G5).
export function reorderGoals(orderedIds: string[]): boolean {
  const active = db
    .select({ id: goal.id })
    .from(goal)
    .where(eq(goal.status, "active"))
    .all()
    .map(g => g.id);
  if (new Set(orderedIds).size !== orderedIds.length) return false;
  if (!orderedIds.every(id => active.includes(id))) return false;
  orderedIds.forEach((id, i) => {
    db.update(goal).set({ sortOrder: i + 1 }).where(eq(goal.id, id)).run();
  });
  emit("goal", null, "goals_reordered", { orderedIds });
  return true;
}

export function listGoals(status?: string) {
  return db
    .select()
    .from(goal)
    .where(status ? eq(goal.status, status as typeof goal.$inferSelect.status) : undefined)
    .orderBy(
      // active first (by sort order), then the rest by recency
      sql`CASE ${goal.status} WHEN 'active' THEN 0 WHEN 'suggested' THEN 1 WHEN 'backlog' THEN 2 WHEN 'dormant' THEN 3 ELSE 4 END`,
      asc(goal.sortOrder),
    )
    .all();
}
