import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { weeklyPlan, weeklyPlanChain } from "../db/schema";
import { mondayOf, todayLocal } from "../lib/time";
import { chainHead, getChainByVersionId } from "./chains";

// Weekly plan reads (post-consolidation). Writes go through save_plan
// (weeklyPlansV3); this module keeps the shared exact-week view used by
// doing mode and the API. Legacy v2 columns (direction, topOutcomes, …)
// survive on old rows as dormant history — nothing writes them anymore.

export function weeklyPlanV2View(id: string) {
  const row = db.select().from(weeklyPlan).where(eq(weeklyPlan.id, id)).get();
  if (!row) return null;
  const chains = db
    .select()
    .from(weeklyPlanChain)
    .where(eq(weeklyPlanChain.weeklyPlanId, id))
    .all()
    .map(link => {
      const head = chainHead(link.chainLineageId);
      return head ? getChainByVersionId(head.id) : null;
    })
    .filter(Boolean);
  return {
    ...row,
    topOutcomes: row.topOutcomesJson ? (JSON.parse(row.topOutcomesJson) as string[]) : [],
    milestones: row.milestonesJson ? (JSON.parse(row.milestonesJson) as string[]) : [],
    failurePoints: row.failurePointsJson ? (JSON.parse(row.failurePointsJson) as { point: string; recovery: string }[]) : [],
    candidateMissions: row.candidateMissionsJson ? (JSON.parse(row.candidateMissionsJson) as string[]) : [],
    chains,
  };
}

/** The plan for the week CONTAINING date — exact week, never a stale one.
 * A five-week-old plan served as "this week" fed daily selection a dead
 * chain menu and let briefings state false facts; no plan for the week is
 * itself the fact ("no weekly yet — make one?"), so null means null. */
export function currentWeeklyPlanV2(date?: string) {
  const forDate = date ?? todayLocal();
  const row = db
    .select()
    .from(weeklyPlan)
    .where(eq(weeklyPlan.weekOf, mondayOf(forDate)))
    .orderBy(desc(weeklyPlan.createdAt))
    .limit(1)
    .get();
  return row ? weeklyPlanV2View(row.id) : null;
}
