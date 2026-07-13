import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  calendarEvent,
  conversation,
  environmentItem,
  experience,
  experiment,
  experimentGoal,
  experimentTask,
  extraction,
  extractionLink,
  goal,
  goalEnvironment,
  goalEvidence,
  goalHabit,
  habit,
  proposal,
} from "../db/schema";
import { attemptCounts } from "./goals";

// The single query layer behind the detail modals: every useful relation the
// data model holds for one goal / habit / experiment / environment item /
// experience, joined once.

export type EntityType = "goal" | "habit" | "environment_item" | "experience" | "experiment" | "experiment_task";

// Extraction provenance, conversation-joined — the rant explorer's shape.
export function extractionsFor(entityType: EntityType, entityId: string) {
  return db
    .select({
      x: extraction,
      conversationTitle: conversation.title,
      conversationDate: conversation.sourceUpdatedAt,
    })
    .from(extractionLink)
    .innerJoin(extraction, eq(extractionLink.extractionId, extraction.id))
    .innerJoin(conversation, eq(extraction.conversationId, conversation.id))
    .where(and(eq(extractionLink.entityType, entityType), eq(extractionLink.entityId, entityId)))
    .all()
    .map(r => ({ ...r.x, conversationTitle: r.conversationTitle, conversationDate: r.conversationDate }));
}

export function calendarEventsFor(entityType: EntityType, entityId: string) {
  return db
    .select()
    .from(calendarEvent)
    .where(and(eq(calendarEvent.entityType, entityType), eq(calendarEvent.entityId, entityId)))
    .orderBy(asc(calendarEvent.startAt))
    .all()
    .filter(e => e.status !== "cancelled");
}

// A compact experiment reference: the attempt archaeology behind the heatmap.
function experimentRef(e: typeof experiment.$inferSelect) {
  return {
    id: e.id,
    title: e.title,
    status: e.status,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    outcomeMd: e.outcomeMd,
  };
}

export function goalDetail(id: string) {
  const row = db.select().from(goal).where(eq(goal.id, id)).get();
  if (!row) return null;

  // Every experiment that tackled it, newest first — including live and queued.
  const experiments = db
    .select({ e: experiment })
    .from(experimentGoal)
    .innerJoin(experiment, eq(experimentGoal.experimentId, experiment.id))
    .where(eq(experimentGoal.goalId, id))
    .orderBy(desc(experiment.createdAt))
    .all()
    .map(r => experimentRef(r.e));

  // The ideal set: what constitutes this goal.
  const idealHabits = db
    .select({ h: habit })
    .from(goalHabit)
    .innerJoin(habit, eq(goalHabit.habitId, habit.id))
    .where(eq(goalHabit.goalId, id))
    .all()
    .map(r => r.h);
  const idealEnvironment = db
    .select({ e: environmentItem })
    .from(goalEnvironment)
    .innerJoin(environmentItem, eq(goalEnvironment.environmentItemId, environmentItem.id))
    .where(eq(goalEnvironment.goalId, id))
    .all()
    .map(r => r.e);

  // When this goal shows up in the week: its ideal set's calendar blocks.
  const schedule = [
    ...idealHabits.flatMap(h => calendarEventsFor("habit", h.id)),
    ...idealEnvironment.flatMap(e => calendarEventsFor("environment_item", e.id)),
  ];

  const evidence = db
    .select({
      id: goalEvidence.id,
      note: goalEvidence.note,
      createdAt: goalEvidence.createdAt,
      conversationTitle: conversation.title,
    })
    .from(goalEvidence)
    .leftJoin(conversation, eq(goalEvidence.conversationId, conversation.id))
    .where(eq(goalEvidence.goalId, id))
    .orderBy(desc(goalEvidence.createdAt))
    .all();

  // Pending proposals aimed at this goal (goal_update / synthesis_update).
  const pendingProposals = db
    .select()
    .from(proposal)
    .where(eq(proposal.status, "pending"))
    .all()
    .map(p => ({ ...p, payload: JSON.parse(p.payloadJson) as { goal_id?: string; title?: string; reason?: string } }))
    .filter(p => p.payload.goal_id === id)
    .map(p => ({ id: p.id, kind: p.kind, title: p.payload.title ?? p.payload.reason ?? p.kind }));

  return {
    ...row,
    attemptCount: attemptCounts().get(id) ?? 0,
    experiments,
    idealHabits,
    idealEnvironment,
    schedule,
    evidence,
    pendingProposals,
    extractions: extractionsFor("goal", id),
  };
}

export function habitDetail(id: string) {
  const row = db.select().from(habit).where(eq(habit.id, id)).get();
  if (!row) return null;
  const goals = db
    .select({ g: goal })
    .from(goalHabit)
    .innerJoin(goal, eq(goalHabit.goalId, goal.id))
    .where(eq(goalHabit.habitId, id))
    .all()
    .map(r => ({ id: r.g.id, title: r.g.title, status: r.g.status }));
  const born = row.experimentId
    ? db.select().from(experiment).where(eq(experiment.id, row.experimentId)).get()
    : null;
  return {
    ...row,
    goals,
    bornInExperiment: born ? experimentRef(born) : null,
    calendarEvents: calendarEventsFor("habit", id),
    extractions: extractionsFor("habit", id),
  };
}

export function environmentDetail(id: string) {
  const row = db.select().from(environmentItem).where(eq(environmentItem.id, id)).get();
  if (!row) return null;
  const goals = db
    .select({ g: goal })
    .from(goalEnvironment)
    .innerJoin(goal, eq(goalEnvironment.goalId, goal.id))
    .where(eq(goalEnvironment.environmentItemId, id))
    .all()
    .map(r => ({ id: r.g.id, title: r.g.title, status: r.g.status }));
  return {
    ...row,
    goals,
    calendarEvents: calendarEventsFor("environment_item", id),
    extractions: extractionsFor("environment_item", id),
  };
}

export function experienceDetail(id: string) {
  const row = db.select().from(experience).where(eq(experience.id, id)).get();
  if (!row) return null;
  let fromExperiment = null;
  if (row.experimentTaskId) {
    const task = db.select().from(experimentTask).where(eq(experimentTask.id, row.experimentTaskId)).get();
    if (task) {
      const exp = db.select().from(experiment).where(eq(experiment.id, task.experimentId)).get();
      if (exp) fromExperiment = { ...experimentRef(exp), taskTitle: task.title };
    }
  }
  return {
    ...row,
    fromExperiment,
    calendarEvents: calendarEventsFor("experience", id),
    extractions: extractionsFor("experience", id),
  };
}

// The experiment's own relations (tasks/goalIds/extractions come from
// experiments.getExperiment; this adds the rest).
export function experimentRelations(experimentId: string) {
  const goals = db
    .select({ g: goal })
    .from(experimentGoal)
    .innerJoin(goal, eq(experimentGoal.goalId, goal.id))
    .where(eq(experimentGoal.experimentId, experimentId))
    .all()
    .map(r => ({ id: r.g.id, title: r.g.title, status: r.g.status }));
  const habitsBorn = db.select().from(habit).where(eq(habit.experimentId, experimentId)).all();
  const taskIds = db
    .select({ id: experimentTask.id })
    .from(experimentTask)
    .where(eq(experimentTask.experimentId, experimentId))
    .all()
    .map(r => r.id);
  const experiences = taskIds.length
    ? db.select().from(experience).where(inArray(experience.experimentTaskId, taskIds)).all()
    : [];
  const calendarEvents = [
    ...calendarEventsFor("experiment", experimentId),
    ...habitsBorn.flatMap(h => calendarEventsFor("habit", h.id)),
    ...taskIds.flatMap(id => calendarEventsFor("experiment_task", id)),
  ];
  return { goals, habitsBorn, experiences, calendarEvents };
}
