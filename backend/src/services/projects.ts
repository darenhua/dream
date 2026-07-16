import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  environmentItem,
  experience,
  experiment,
  goal,
  habit,
  project,
  projectSource,
} from "../db/schema";
import { emit } from "./events";

type ProjectRow = typeof project.$inferSelect;

// These are intentionally raw records only. The project registry gives
// proposal-derived things-to-make a lightweight home without turning them
// into an organized record or a task-management system.
export type ProjectSourceRef = {
  entity_type: "goal" | "habit" | "environment_item" | "experience" | "experiment";
  entity_id: string;
};

export function listProjects() {
  return db.select().from(project).orderBy(asc(project.createdAt)).all();
}

export function createProject(fields: {
  title: string;
  note?: string | null;
  origin: ProjectRow["origin"];
}): ProjectRow {
  const row = db
    .insert(project)
    .values({
      title: fields.title,
      note: fields.note ?? null,
      origin: fields.origin,
    })
    .returning()
    .get();
  emit("project", row.id, "project_created", { title: row.title, origin: row.origin });
  return row;
}

function rawSourceExists(ref: ProjectSourceRef) {
  switch (ref.entity_type) {
    case "goal":
      return Boolean(db.select({ id: goal.id }).from(goal).where(eq(goal.id, ref.entity_id)).get());
    case "habit":
      return Boolean(db.select({ id: habit.id }).from(habit).where(eq(habit.id, ref.entity_id)).get());
    case "environment_item":
      return Boolean(
        db.select({ id: environmentItem.id }).from(environmentItem).where(eq(environmentItem.id, ref.entity_id)).get(),
      );
    case "experience":
      return Boolean(
        db.select({ id: experience.id }).from(experience).where(eq(experience.id, ref.entity_id)).get(),
      );
    case "experiment":
      return Boolean(
        db.select({ id: experiment.id }).from(experiment).where(eq(experiment.id, ref.entity_id)).get(),
      );
  }
}

// Explicit source context complements extraction_link's canonical rant
// provenance. It lets a project point at existing raw material without
// inventing an organized relationship.
export function linkProjectSources(projectId: string, refs: ProjectSourceRef[] | undefined) {
  const unique = new Map<string, ProjectSourceRef>();
  for (const ref of refs ?? []) unique.set(`${ref.entity_type}:${ref.entity_id}`, ref);

  for (const ref of unique.values()) {
    if (!rawSourceExists(ref)) {
      throw new Error(`project source ${ref.entity_type}:${ref.entity_id} not found`);
    }
  }
  for (const ref of unique.values()) {
    db.insert(projectSource)
      .values({ projectId, entityType: ref.entity_type, entityId: ref.entity_id })
      .onConflictDoNothing()
      .run();
  }
}
