import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { experience } from "../db/schema";
import { emit } from "./events";

type ExperienceRow = typeof experience.$inferSelect;

// Append-only: experiences are created and can transition planned → had,
// but there is no prune/removal path anywhere in the domain.

export function listExperiences(state?: string) {
  return db
    .select()
    .from(experience)
    .where(state ? eq(experience.state, state as ExperienceRow["state"]) : undefined)
    .orderBy(asc(experience.createdAt))
    .all();
}

export function createExperience(fields: {
  title: string;
  note?: string | null;
  state: ExperienceRow["state"];
  plannedFor?: string | null;
  hadAt?: string | null;
  experimentTaskId?: string | null;
  origin: ExperienceRow["origin"];
}): ExperienceRow {
  const row = db
    .insert(experience)
    .values({
      title: fields.title,
      note: fields.note ?? null,
      state: fields.state,
      plannedFor: fields.plannedFor ?? null,
      hadAt: fields.hadAt ?? (fields.state === "had" ? new Date().toISOString() : null),
      experimentTaskId: fields.experimentTaskId ?? null,
      origin: fields.origin,
    })
    .returning()
    .get();
  emit("experience", row.id, "experience_created", { title: row.title, state: row.state });
  return row;
}

// planned → had: it happened.
export function markExperienceHad(id: string, note?: string) {
  const existing = db.select().from(experience).where(eq(experience.id, id)).get();
  if (!existing) return null;
  if (existing.state === "had") return existing;
  const updated = db
    .update(experience)
    .set({ state: "had", hadAt: new Date().toISOString(), note: note ?? existing.note })
    .where(eq(experience.id, id))
    .returning()
    .get();
  emit("experience", id, "experience_had", {});
  return updated;
}
