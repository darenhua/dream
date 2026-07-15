import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "../db";
import { goal, witness, witnessGoal } from "../db/schema";
import { emit } from "./events";
import { cancelPendingForWitness } from "./outbox";

// The witness registry. The seat is the feature; the occupant is replaceable.
// Witnesses never enforce or track — the system holds all state and arms them
// with specific things to ask. Their duties: notice review silence, and when
// the strike alert fires, ask one question.

export type WitnessRow = typeof witness.$inferSelect;

export function listWitnesses(): (WitnessRow & { goalIds: string[] })[] {
  const rows = db
    .select()
    .from(witness)
    .where(ne(witness.status, "removed"))
    .orderBy(asc(witness.createdAt))
    .all();
  return rows.map(w => ({ ...w, goalIds: scopedGoalIds(w.id) }));
}

export function getWitness(id: string) {
  return db.select().from(witness).where(eq(witness.id, id)).get() ?? null;
}

export function scopedGoalIds(witnessId: string): string[] {
  return db
    .select({ goalId: witnessGoal.goalId })
    .from(witnessGoal)
    .where(eq(witnessGoal.witnessId, witnessId))
    .all()
    .map(r => r.goalId);
}

// Invite: creates the seat + a one-time code the (future) chat transport uses
// to bind a chat to this witness ("text JOIN <code>"). Until then the code is
// just a handle; the manual protocol needs nothing more than the row.
export function createInvite(fields: {
  name: string;
  handle?: string;
  timezone?: string;
  isPrimary?: boolean;
  goalIds?: string[];
}) {
  const inviteCode = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const row = db
    .insert(witness)
    .values({
      name: fields.name,
      handle: fields.handle ?? null,
      timezone: fields.timezone ?? "America/New_York",
      inviteCode,
    })
    .returning()
    .get();
  if (fields.goalIds?.length) setGoals(row.id, fields.goalIds);
  if (fields.isPrimary) setPrimary(row.id);
  emit("witness", row.id, "witness_invited", { name: fields.name });
  return getWitness(row.id)!;
}

export function patchWitness(
  id: string,
  patch: Partial<
    Pick<
      WitnessRow,
      "name" | "handle" | "timezone" | "status" | "promptCadenceDays" | "chatId" | "linkRequestedAt"
    >
  >,
) {
  const row = getWitness(id);
  if (!row) return null;
  const updated = db.update(witness).set(patch).where(eq(witness.id, id)).returning().get();
  emit("witness", id, "witness_updated", { fields: Object.keys(patch) });
  return updated;
}

// Scope change = delete-and-reinsert. Only real goals survive the write, and
// this witness's pending outbound messages are cancelled so a re-scope can't
// leak already-composed content.
export function setGoals(witnessId: string, goalIds: string[]) {
  cancelPendingForWitness(witnessId);
  const known = new Set(
    db
      .select({ id: goal.id })
      .from(goal)
      .all()
      .map(r => r.id),
  );
  const valid = [...new Set(goalIds)].filter(g => known.has(g));
  db.transaction(() => {
    db.delete(witnessGoal).where(eq(witnessGoal.witnessId, witnessId)).run();
    for (const goalId of valid) {
      db.insert(witnessGoal).values({ witnessId, goalId }).onConflictDoNothing().run();
    }
  });
  emit("witness", witnessId, "witness_goals_set", { goalIds: valid });
  return valid;
}

// Exactly one primary — the strike-alert friend.
export function setPrimary(id: string) {
  const row = getWitness(id);
  if (!row) throw new Error(`witness ${id} not found`);
  db.transaction(() => {
    db.update(witness).set({ isPrimary: false }).where(eq(witness.isPrimary, true)).run();
    db.update(witness).set({ isPrimary: true }).where(eq(witness.id, id)).run();
  });
  emit("witness", id, "witness_set_primary", {});
}

export function removeWitness(id: string) {
  const row = getWitness(id);
  if (!row) return false;
  db.update(witness)
    .set({ status: "removed", isPrimary: false, chatId: null })
    .where(eq(witness.id, id))
    .run();
  emit("witness", id, "witness_removed", {});
  return true;
}

// The strike tripwire's precondition: a primary witness whose chat is linked.
export function linkedPrimaryWitness(): WitnessRow | null {
  return (
    db
      .select()
      .from(witness)
      .where(and(eq(witness.isPrimary, true), eq(witness.status, "active"), isNotNull(witness.chatId)))
      .get() ?? null
  );
}
