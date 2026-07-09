import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { goalHabit, habit } from "../db/schema";
import { emit } from "./events";

type HabitRow = typeof habit.$inferSelect;
type HabitStatus = HabitRow["status"];

export function listHabits(status?: string) {
  return db
    .select()
    .from(habit)
    .where(status ? eq(habit.status, status as HabitStatus) : undefined)
    .orderBy(asc(habit.createdAt))
    .all();
}

export function createHabit(fields: {
  title: string;
  note?: string | null;
  valence?: "good" | "bad";
  status: HabitStatus;
  rrule?: string | null;
  preferredTime?: string | null;
  durationMinutes?: number | null;
  experimentId?: string | null;
  origin: HabitRow["origin"];
  goalIds?: string[];
}): HabitRow {
  const row = db
    .insert(habit)
    .values({
      title: fields.title,
      note: fields.note ?? null,
      valence: fields.valence ?? "good",
      status: fields.status,
      rrule: fields.rrule ?? null,
      preferredTime: fields.preferredTime ?? null,
      durationMinutes: fields.durationMinutes ?? null,
      experimentId: fields.experimentId ?? null,
      origin: fields.origin,
    })
    .returning()
    .get();
  for (const goalId of fields.goalIds ?? []) linkHabitToGoal(goalId, row.id);
  emit("habit", row.id, "habit_created", { title: row.title, status: row.status, origin: row.origin });
  return row;
}

export function patchHabit(
  id: string,
  patch: Partial<Pick<HabitRow, "title" | "note" | "valence" | "status" | "rrule" | "preferredTime" | "durationMinutes">>,
) {
  const existing = db.select().from(habit).where(eq(habit.id, id)).get();
  if (!existing) return null;
  const updated = db.update(habit).set(patch).where(eq(habit.id, id)).returning().get();
  if (patch.status && patch.status !== existing.status) {
    emit("habit", id, "habit_status_changed", { from: existing.status, to: patch.status });
  } else {
    emit("habit", id, "habit_updated", { fields: Object.keys(patch) });
  }
  return updated;
}

export function linkHabitToGoal(goalId: string, habitId: string) {
  db.insert(goalHabit).values({ goalId, habitId }).onConflictDoNothing().run();
}

export function unlinkHabitFromGoal(goalId: string, habitId: string): boolean {
  const existing = db
    .select()
    .from(goalHabit)
    .where(and(eq(goalHabit.goalId, goalId), eq(goalHabit.habitId, habitId)))
    .get();
  if (!existing) return false;
  db.delete(goalHabit).where(eq(goalHabit.id, existing.id)).run();
  return true;
}

// Experiment end: only complete success means the habit truly took.
export function graduateExperimentHabits(experimentId: string): number {
  const rows = db
    .update(habit)
    .set({ status: "established" })
    .where(and(eq(habit.experimentId, experimentId), eq(habit.status, "building")))
    .returning({ id: habit.id })
    .all();
  for (const r of rows) emit("habit", r.id, "habit_established", { experimentId });
  return rows.length;
}

export function lapseExperimentHabits(experimentId: string): number {
  const rows = db
    .update(habit)
    .set({ status: "lapsed" })
    .where(and(eq(habit.experimentId, experimentId), eq(habit.status, "building")))
    .returning({ id: habit.id })
    .all();
  for (const r of rows) emit("habit", r.id, "habit_lapsed", { experimentId });
  return rows.length;
}
