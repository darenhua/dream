import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { environmentItem, goalEnvironment } from "../db/schema";
import { emit } from "./events";

type EnvRow = typeof environmentItem.$inferSelect;

export function listEnvironment(opts: { subKind?: string; status?: string } = {}) {
  const conds = [];
  if (opts.subKind) conds.push(eq(environmentItem.subKind, opts.subKind as EnvRow["subKind"]));
  if (opts.status) conds.push(eq(environmentItem.status, opts.status as EnvRow["status"]));
  return db
    .select()
    .from(environmentItem)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(environmentItem.createdAt))
    .all();
}

export function createEnvironmentItem(fields: {
  title: string;
  subKind: EnvRow["subKind"];
  note?: string | null;
  rrule?: string | null;
  durationMinutes?: number | null;
  origin: EnvRow["origin"];
  goalIds?: string[];
}): EnvRow {
  // Only obligations schedule; a physical setup with an rrule is a modeling error.
  const schedulable = fields.subKind === "obligation";
  const row = db
    .insert(environmentItem)
    .values({
      title: fields.title,
      subKind: fields.subKind,
      note: fields.note ?? null,
      rrule: schedulable ? (fields.rrule ?? null) : null,
      durationMinutes: schedulable ? (fields.durationMinutes ?? null) : null,
      origin: fields.origin,
    })
    .returning()
    .get();
  for (const goalId of fields.goalIds ?? []) linkEnvironmentToGoal(goalId, row.id);
  emit("environment_item", row.id, "environment_created", { title: row.title, subKind: row.subKind });
  return row;
}

export function patchEnvironmentItem(
  id: string,
  patch: Partial<Pick<EnvRow, "title" | "note" | "subKind" | "status" | "rrule" | "durationMinutes">>,
) {
  const existing = db.select().from(environmentItem).where(eq(environmentItem.id, id)).get();
  if (!existing) return null;
  const subKind = patch.subKind ?? existing.subKind;
  if (subKind !== "obligation") {
    patch.rrule = null;
    patch.durationMinutes = null;
  }
  const updated = db.update(environmentItem).set(patch).where(eq(environmentItem.id, id)).returning().get();
  emit("environment_item", id, "environment_updated", { fields: Object.keys(patch) });
  return updated;
}

export function linkEnvironmentToGoal(goalId: string, environmentItemId: string) {
  db.insert(goalEnvironment).values({ goalId, environmentItemId }).onConflictDoNothing().run();
}
