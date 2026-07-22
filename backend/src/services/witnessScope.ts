import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  experiment,
  experimentGoal,
  experimentTask,
  experimentTaskGoal,
  goal,
  goalHabit,
  habit,
} from "../db/schema";
import { scopedGoalIds } from "./witnesses";

// THE privacy boundary of the witness feature, enforced at the query layer:
// everything a witness-facing agent or message can ever contain is built
// exclusively from what these functions return. The composer LLM cannot leak
// what was never projected. Rules:
//   - a witness sees an experiment only if it targets ≥1 of their goals
//   - within it, only tasks/habits tagged to their goals (untagged = INVISIBLE)
//   - raw rants and extractions are NEVER projected to witness-facing agents

export interface ScopedExperimentView {
  id: string;
  title: string;
  hypothesisMd: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  plannedDurationDays: number | null;
  goals: { id: string; title: string; identityClause: string | null }[]; // scoped ∩ experiment goals only
  tasks: { title: string; detail: string | null; status: string }[];
  habits: { title: string; note: string | null; status: string }[];
}

// Scoped goal titles — used for the group-welcome message ("what this chat
// will hear about"), never for content beyond the boundary above.
export function witnessGoalTitles(witnessId: string): string[] {
  const ids = scopedGoalIds(witnessId);
  if (!ids.length) return [];
  return db
    .select({ title: goal.title })
    .from(goal)
    .where(inArray(goal.id, ids))
    .all()
    .map(g => g.title);
}

export function visibleExperimentIds(witnessId: string): string[] {
  const scope = scopedGoalIds(witnessId);
  if (scope.length === 0) return []; // fail closed
  return [
    ...new Set(
      db
        .select({ experimentId: experimentGoal.experimentId })
        .from(experimentGoal)
        .innerJoin(experiment, eq(experiment.id, experimentGoal.experimentId))
        .where(and(inArray(experimentGoal.goalId, scope), eq(experiment.kind, "actionable")))
        .all()
        .map(r => r.experimentId),
    ),
  ];
}

export function scopedExperimentView(witnessId: string, experimentId: string): ScopedExperimentView | null {
  const scope = scopedGoalIds(witnessId);
  if (scope.length === 0) return null;
  if (!visibleExperimentIds(witnessId).includes(experimentId)) return null;

  const row = db.select().from(experiment).where(eq(experiment.id, experimentId)).get();
  if (!row || row.kind !== "actionable") return null;

  const sharedGoals = db
    .select({ id: goal.id, title: goal.title, identityClause: goal.identityClause })
    .from(experimentGoal)
    .innerJoin(goal, eq(goal.id, experimentGoal.goalId))
    .where(and(eq(experimentGoal.experimentId, experimentId), inArray(experimentGoal.goalId, scope)))
    .all();

  // Tasks: only those tagged to an in-scope goal. No tag row = invisible.
  const tasks = db
    .selectDistinct({ title: experimentTask.title, detail: experimentTask.detail, status: experimentTask.status })
    .from(experimentTask)
    .innerJoin(experimentTaskGoal, eq(experimentTaskGoal.experimentTaskId, experimentTask.id))
    .where(and(eq(experimentTask.experimentId, experimentId), inArray(experimentTaskGoal.goalId, scope)))
    .all();

  // Habits born in this experiment: visible only via an in-scope goalHabit link.
  const habits = db
    .selectDistinct({ title: habit.title, note: habit.note, status: habit.status })
    .from(habit)
    .innerJoin(goalHabit, eq(goalHabit.habitId, habit.id))
    .where(and(eq(habit.experimentId, experimentId), inArray(goalHabit.goalId, scope)))
    .all();

  return {
    id: row.id,
    title: row.title,
    hypothesisMd: row.hypothesisMd,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    plannedDurationDays: row.plannedDurationDays,
    goals: sharedGoals,
    tasks,
    habits,
  };
}

// The ONLY workspace content any witness-facing agent ever receives.
export function witnessContextMd(witnessId: string): string {
  const scope = scopedGoalIds(witnessId);
  if (scope.length === 0) return "# Scope\n\n_(no goals shared with this witness)_\n";

  const goals = db
    .select()
    .from(goal)
    .where(inArray(goal.id, scope))
    .all();

  const sections: string[] = ["# What this witness can see\n"];
  sections.push("## Shared goals\n");
  for (const g of goals) {
    sections.push(`- **${g.title}**${g.identityClause ? ` — ${g.identityClause}` : ""} (status: ${g.status})`);
  }

  const experiments = visibleExperimentIds(witnessId)
    .map(id => scopedExperimentView(witnessId, id))
    .filter((v): v is ScopedExperimentView => v !== null)
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  sections.push("\n## Experiments touching those goals (scoped parts only)\n");
  if (experiments.length === 0) sections.push("_(none yet)_");
  for (const e of experiments) {
    sections.push(`### ${e.title} — ${e.status}`);
    if (e.hypothesisMd) sections.push(e.hypothesisMd);
    if (e.tasks.length) {
      sections.push("Tasks:");
      for (const t of e.tasks) sections.push(`- [${t.status}] ${t.title}${t.detail ? ` — ${t.detail}` : ""}`);
    }
    if (e.habits.length) {
      sections.push("Habits being built:");
      for (const h of e.habits) sections.push(`- [${h.status}] ${h.title}${h.note ? ` — ${h.note}` : ""}`);
    }
  }
  return sections.join("\n");
}
