import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { planDoc } from "../db/schema";

// One-pager living context docs (PLANNING_REVAMP_SPEC §4.6). Docs accrete
// during conversations; the plan records they annotate stay stable. refId =
// dailyPlan id (daily) / weekly_plan id (weekly) / currentFocus id (monthly).

export type PlanDocScope = "daily" | "weekly" | "monthly";

export function getPlanDoc(scope: PlanDocScope, refId: string) {
  return db
    .select()
    .from(planDoc)
    .where(and(eq(planDoc.scope, scope), eq(planDoc.refId, refId)))
    .get();
}

export function upsertPlanDoc(scope: PlanDocScope, refId: string, contentMd: string) {
  const existing = getPlanDoc(scope, refId);
  if (existing) {
    db.update(planDoc).set({ contentMd }).where(eq(planDoc.id, existing.id)).run();
    return getPlanDoc(scope, refId)!;
  }
  return db.insert(planDoc).values({ scope, refId, contentMd }).returning().get();
}

/** Append a section — the normal conversational move. Docs grow; they are
 * never silently rewritten. */
export function appendPlanDoc(scope: PlanDocScope, refId: string, contentMd: string) {
  const existing = getPlanDoc(scope, refId);
  if (!existing) return upsertPlanDoc(scope, refId, contentMd);
  return upsertPlanDoc(scope, refId, `${existing.contentMd.trimEnd()}\n\n${contentMd.trim()}`);
}
