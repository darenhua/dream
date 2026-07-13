import { asc, count, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "../db";
import { experiment, experimentGoal, goal } from "../db/schema";
import { getConfig } from "./config";
import { emit } from "./events";

type GoalStatus = typeof goal.$inferSelect.status;

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

// MAX_ACTIVE_GOALS gates ALL paths into `active` — overflow lands in backlog
// and the caller is told.
function capStatus(requested: GoalStatus): { status: GoalStatus; note?: string } {
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
  title: string;
  identityClause?: string | null;
  synthesisMd?: string | null;
  status?: GoalStatus;
  origin: "derived" | "manual";
}): { goal: typeof goal.$inferSelect; note?: string } {
  const requested = fields.status ?? "active";
  const { status, note } = capStatus(requested);
  const row = db
    .insert(goal)
    .values({
      title: fields.title,
      identityClause: fields.identityClause ?? null,
      synthesisMd: fields.synthesisMd ?? null,
      status,
      sortOrder: status === "active" ? nextSortOrder() : 0,
      origin: fields.origin,
    })
    .returning()
    .get();
  emit("goal", row.id, "goal_created", { title: row.title, status: row.status, origin: row.origin });
  return { goal: row, note };
}

// Terminal states (succeeded | irrelevant) are one-way for agents; leaving
// them is a manual admin escape hatch handled at the route layer.
export function setGoalStatus(
  goalId: string,
  requested: GoalStatus,
): { goal: typeof goal.$inferSelect; note?: string } | null {
  const existing = db.select().from(goal).where(eq(goal.id, goalId)).get();
  if (!existing) return null;
  const { status, note } = capStatus(requested);
  const row = db
    .update(goal)
    .set({
      status,
      sortOrder: status === "active" ? nextSortOrder() : existing.sortOrder,
    })
    .where(eq(goal.id, goalId))
    .returning()
    .get();
  emit("goal", goalId, "goal_status_changed", { from: existing.status, to: status });
  return { goal: row, note };
}

// Reordering emits an event and asks nothing.
export function reorderGoals(orderedIds: string[]): boolean {
  const active = db
    .select({ id: goal.id })
    .from(goal)
    .where(eq(goal.status, "active"))
    .all()
    .map(g => g.id);
  if (new Set(orderedIds).size !== orderedIds.length) return false;
  if (orderedIds.length !== active.length) return false; // must be the exact active set
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
    .where(status ? eq(goal.status, status as GoalStatus) : undefined)
    .orderBy(
      // active first (by sort order), then the working pool, terminals last
      sql`CASE ${goal.status} WHEN 'active' THEN 0 WHEN 'backlog' THEN 1 WHEN 'dormant' THEN 2 WHEN 'succeeded' THEN 3 ELSE 4 END`,
      asc(goal.sortOrder),
    )
    .all();
}

// The heatmap: how many ended experiments have tackled each goal. Light green
// first try, dark forest after twenty — every ended experiment counts.
export function attemptCounts(): Map<string, number> {
  const rows = db
    .select({ goalId: experimentGoal.goalId, n: count() })
    .from(experimentGoal)
    .innerJoin(experiment, eq(experimentGoal.experimentId, experiment.id))
    .where(inArray(experiment.status, ["succeeded", "failed"]))
    .groupBy(experimentGoal.goalId)
    .all();
  return new Map(rows.map(r => [r.goalId, r.n]));
}
