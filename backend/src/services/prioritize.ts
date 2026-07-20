import { desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { currentFocus, experimentGroup, experimentGroupGoal, groupIdea } from "../db/schema";
import { todayLocal } from "../lib/time";
import { lineageHead } from "./records";
import { readRecord } from "./recordReads";

// Prioritize (Phase 5): the monthly-level decision. One pick at a time,
// carrying an end date; expiry re-arms prioritization. State derives from
// timestamps — a pick is current iff ended_at is null AND today <= end_date.

export type PickState = {
  pick: typeof currentFocus.$inferSelect;
  groupLineageId: string;
  expired: boolean;
} | null;

/** The latest un-ended pick, with derived expiry. */
export function latestPick(): PickState {
  const row = db
    .select()
    .from(currentFocus)
    .where(isNull(currentFocus.endedAt))
    .orderBy(desc(currentFocus.startedAt))
    .limit(1)
    .get();
  if (!row) return null;
  const groupVersion = db.select().from(experimentGroup).where(eq(experimentGroup.id, row.experimentGroupId)).get();
  const expired = row.endDate != null && row.endDate < todayLocal();
  return { pick: row, groupLineageId: groupVersion?.lineageId ?? row.experimentGroupId, expired };
}

export function currentPick(): PickState {
  const state = latestPick();
  return state && !state.expired ? state : null;
}

/** The prioritize conversation's landscape: candidate groups (lineage heads,
 * not archived, not currently picked) with goal sets, idea counts and
 * done-states, plus the current/expired pick. */
export function prioritizeContext() {
  const groups = db.select().from(experimentGroup).all();
  const heads = new Map<string, typeof experimentGroup.$inferSelect>();
  for (const row of groups) {
    const key = row.lineageId ?? row.id;
    const prev = heads.get(key);
    if (!prev || (row.version ?? 1) > (prev.version ?? 1)) heads.set(key, row);
  }
  const pickState = latestPick();
  const candidates = [...heads.entries()]
    .filter(([, head]) => !head.archivedAt)
    .filter(([lineageId]) => !(pickState && !pickState.expired && pickState.groupLineageId === lineageId))
    .map(([lineageId, head]) => {
      const goalSet = db
        .select()
        .from(experimentGroupGoal)
        .where(eq(experimentGroupGoal.experimentGroupId, lineageId))
        .all()
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map(row => {
          const goal = lineageHead("organized_goal", row.organizedGoalId);
          return { lineageId: row.organizedGoalId, title: goal?.title ?? "(missing)", rank: row.rank };
        });
      const members = db.select().from(groupIdea).where(eq(groupIdea.groupLineageId, lineageId)).all();
      return {
        lineageId,
        title: head.title,
        theme: head.theme,
        description: head.description ?? head.motivationMd,
        version: head.version ?? 1,
        goalSet,
        ideaCount: members.length,
        ideasDone: members.filter(m => m.doneAt).length,
      };
    });

  return {
    today: todayLocal(),
    currentPick: pickState
      ? {
          groupLineageId: pickState.groupLineageId,
          endDate: pickState.pick.endDate,
          startedAt: pickState.pick.startedAt,
          expired: pickState.expired,
          reasoning: pickState.pick.reasoningMd,
          group: readRecord("experiment_group", pickState.groupLineageId),
        }
      : null,
    candidates,
  };
}

/** Applies a pick operation inside the change-set transaction. The group ref
 * has already been temp-resolved to a lineage id by the caller. */
export function applyPick(input: { groupLineageId: string; endDate: string; reasoning: string }, changeSetId: string): string {
  const head = lineageHead("experiment_group", input.groupLineageId);
  if (!head) throw new Error(`experiment group ${input.groupLineageId} not found`);
  if ((head as { archivedAt?: string | null }).archivedAt) throw new Error("an archived group cannot be picked");
  if (input.endDate <= todayLocal()) throw new Error("the pick's end date must be in the future");

  const existing = latestPick();
  if (existing && !existing.expired) {
    throw new Error("a current pick already exists; it must expire (or be ended) before a new prioritization");
  }
  // An expired-but-unended pick is closed by the new decision; the legacy
  // status column shadows the timestamps to keep the one-current unique index.
  if (existing) {
    db.update(currentFocus)
      .set({ status: "ended", endedAt: new Date().toISOString() })
      .where(eq(currentFocus.id, existing.pick.id))
      .run();
  }
  const previousId =
    existing?.pick.id ?? db.select({ id: currentFocus.id }).from(currentFocus).orderBy(desc(currentFocus.startedAt)).get()?.id ?? null;

  const row = db
    .insert(currentFocus)
    .values({
      experimentGroupId: head.id, // PINNED version id — the group as it was when picked
      previousCurrentFocusId: previousId,
      status: "current",
      entryReason: "pick",
      reasoningMd: input.reasoning,
      sourceChangeSetId: changeSetId,
      endDate: input.endDate,
      startedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  return row.id;
}
