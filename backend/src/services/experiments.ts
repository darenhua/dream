import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  calendarEvent,
  chatSession,
  experiment,
  experimentGroup,
  experimentGoal,
  experimentTask,
  experimentTaskGoal,
  extraction,
  extractionLink,
  goalEvidence,
  habit,
} from "../db/schema";
import type { SchedulePlanT } from "../domain/schemas";
import { hhmmToMin, zonedIso } from "../lib/time";
import { isConnected, pushEvent } from "./calendarSync";
import { getConfig } from "./config";
import { experimentRelations, extractionsFor } from "./entityDetail";
import { emit } from "./events";
import { createExperience } from "./experiences";
import { createHabit, graduateExperimentHabits, lapseExperimentHabits } from "./habits";

// The executable experiment FSM: queued → scheduling → running → succeeded |
// failed. Raw proposal-derived experiments are *candidates*, not work in this
// FSM. Only user-reviewed weekly actionables may enter it.

type ExperimentRow = typeof experiment.$inferSelect;

export function liveExperiment(): ExperimentRow | null {
  return (
    db
      .select()
      .from(experiment)
      .where(and(eq(experiment.kind, "actionable"), inArray(experiment.status, ["scheduling", "running"])))
      .get() ?? null
  );
}

// Called by the raw proposal apply-switch on approval. This records material
// the user can later draw on; it does not enqueue executable work.
export function enqueueExperiment(fields: {
  title: string;
  hypothesisMd: string;
  goalIds: string[];
  proposalId: string;
  proposedChanges?: unknown[];
}): ExperimentRow {
  const row = db
    .insert(experiment)
    .values({
      title: fields.title,
      hypothesisMd: fields.hypothesisMd,
      kind: "candidate",
      status: "queued",
      proposalId: fields.proposalId,
      proposedChangesJson: fields.proposedChanges ? JSON.stringify(fields.proposedChanges) : null,
      queuedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  for (const goalId of fields.goalIds) {
    db.insert(experimentGoal).values({ experimentId: row.id, goalId }).onConflictDoNothing().run();
  }
  emit("experiment", row.id, "experiment_candidate_created", { title: row.title });
  return row;
}

export function listQueue() {
  return db
    .select()
    .from(experiment)
    .where(and(eq(experiment.kind, "actionable"), inArray(experiment.status, ["queued", "scheduling"])))
    .orderBy(asc(experiment.queuedAt))
    .all();
}

// Proposal-derived candidates are durable reference material, not a hidden
// execution queue. Keep even user-archived candidates visible here: archiving
// only says "do not foreground this right now," not "erase the idea or its
// provenance."
export function listCandidates() {
  return db
    .select()
    .from(experiment)
    .where(eq(experiment.kind, "candidate"))
    .orderBy(desc(experiment.createdAt))
    .all();
}

export function currentExperiment() {
  // The running one, else the queue head — the feed card never blanks needlessly.
  const running = db
    .select()
    .from(experiment)
    .where(and(eq(experiment.kind, "actionable"), eq(experiment.status, "running")))
    .get();
  const row = running ?? listQueue()[0] ?? null;
  if (!row) return null;
  const daysRunning = row.startedAt
    ? Math.floor((Date.now() - new Date(row.startedAt).getTime()) / 86_400_000)
    : null;
  return {
    ...row,
    daysRunning,
    isRunning: row.status === "running",
    tasks: listTasks(row.id),
    goalIds: goalIdsFor(row.id),
  };
}

export function experimentHistory() {
  return db
    .select()
    .from(experiment)
    .where(and(eq(experiment.kind, "actionable"), inArray(experiment.status, ["succeeded", "failed"])))
    .orderBy(desc(experiment.endedAt))
    .all();
}

export function getExperiment(id: string) {
  const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
  if (!row) return null;
  const relations = experimentRelations(id);
  return {
    ...row,
    proposedChanges: row.proposedChangesJson ? (JSON.parse(row.proposedChangesJson) as unknown[]) : null,
    tasks: listTasks(id),
    goalIds: goalIdsFor(id),
    extractions: extractionsFor("experiment", id),
    ...relations,
  };
}

export function goalIdsFor(experimentId: string): string[] {
  return db
    .select({ goalId: experimentGoal.goalId })
    .from(experimentGoal)
    .where(eq(experimentGoal.experimentId, experimentId))
    .all()
    .map(r => r.goalId);
}

export function listTasks(experimentId: string) {
  return db
    .select()
    .from(experimentTask)
    .where(eq(experimentTask.experimentId, experimentId))
    .orderBy(asc(experimentTask.createdAt))
    .all();
}

// queued → scheduling. Guard: one experiment at a time, including one being
// scheduled — picking opens the schedule-agent chat session.
export function pickExperiment(id: string): { ok: true; sessionId: string } | { ok: false; error: string } {
  const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
  if (!row) return { ok: false, error: "experiment not found" };
  if (row.kind !== "actionable") {
    return { ok: false, error: "raw experiment candidates are reference material, not runnable experiments" };
  }
  if (row.experimentGroupId) {
    return {
      ok: false,
      error: "this reviewed weekly actionable already has its task plan; confirm its schedule instead",
    };
  }
  if (row.status !== "queued") return { ok: false, error: `experiment is ${row.status}, not queued` };
  const live = liveExperiment();
  if (live) {
    return {
      ok: false,
      error: `"${live.title}" is ${live.status} — one experiment at a time; end or cancel it first`,
    };
  }
  db.update(experiment).set({ status: "scheduling" }).where(eq(experiment.id, id)).run();
  const session = db.insert(chatSession).values({ purpose: "schedule", experimentId: id }).returning().get();
  emit("experiment", id, "experiment_scheduling", { sessionId: session.id });
  return { ok: true, sessionId: session.id };
}

// scheduling → queued (bailing out of the chat is free).
export function cancelScheduling(id: string): { ok: boolean; error?: string } {
  const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
  if (!row) return { ok: false, error: "experiment not found" };
  if (row.kind !== "actionable") return { ok: false, error: "raw experiment candidates cannot be scheduled" };
  if (row.status !== "scheduling") return { ok: false, error: `experiment is ${row.status}, not scheduling` };
  db.update(experiment).set({ status: "queued" }).where(eq(experiment.id, id)).run();
  db.update(chatSession)
    .set({ status: "cancelled" })
    .where(eq(chatSession.experimentId, id))
    .run();
  emit("experiment", id, "experiment_scheduling_cancelled", {});
  return { ok: true };
}

// scheduling → running: the plan the chat converged on becomes real —
// building habits, tasks, planned experiences. Calendar pushes are the
// caller's job (scheduleChat.confirm) so this stays testable without GCal.
export function commitPlan(
  experimentId: string,
  plan: SchedulePlanT,
): { ok: true; experiment: ExperimentRow } | { ok: false; error: string } {
  const row = db.select().from(experiment).where(eq(experiment.id, experimentId)).get();
  if (!row) return { ok: false, error: "experiment not found" };
  if (row.kind !== "actionable") return { ok: false, error: "raw experiment candidates cannot receive a schedule plan" };
  if (row.experimentGroupId) {
    return {
      ok: false,
      error: "reviewed weekly actionables already have a task plan; use explicit schedule confirmation",
    };
  }
  if (row.status !== "scheduling") return { ok: false, error: `experiment is ${row.status}, not scheduling` };

  // Goal tags gate witness visibility, so they must always resolve to real
  // goals of THIS experiment: agent-provided ids are intersected with the
  // experiment's own goal set; missing/empty tags default to the full set
  // (an untagged task must never become an invisible orphan).
  const experimentGoalIds = goalIdsFor(experimentId);
  const resolveGoalTags = (tagged?: string[]): string[] => {
    const valid = (tagged ?? []).filter(g => experimentGoalIds.includes(g));
    return valid.length > 0 ? valid : experimentGoalIds;
  };

  let updated: ExperimentRow;
  db.transaction(() => {
    updated = db
      .update(experiment)
      .set({
        status: "running",
        startedAt: new Date().toISOString(),
        hypothesisMd: plan.hypothesis_md || row.hypothesisMd,
        bandwidth: plan.bandwidth ?? null,
        plannedDurationDays: plan.planned_duration_days ?? getConfig<number>("EXPERIMENT_DEFAULT_DURATION_DAYS"),
        planJson: JSON.stringify(plan),
      })
      .where(eq(experiment.id, experimentId))
      .returning()
      .get();

    for (const t of plan.tasks) {
      const task = db
        .insert(experimentTask)
        .values({
          experimentId,
          kind: t.kind,
          title: t.title,
          detail: t.detail ?? null,
          status: "scheduled",
          scheduledFor: t.start,
        })
        .returning()
        .get();
      if (t.kind === "experience") {
        createExperience({
          title: t.title,
          note: t.detail ?? null,
          state: "planned",
          plannedFor: t.start,
          experimentTaskId: task.id,
          origin: "experiment",
        });
      }
      // Task-level provenance inherits the extractions the agent cited.
      for (const extractionId of t.extraction_ids ?? []) {
        db.insert(extractionLink)
          .values({ extractionId, entityType: "experiment_task", entityId: task.id })
          .onConflictDoNothing()
          .run();
      }
      // Task → goal links: the granularity witness scoping filters on.
      for (const goalId of resolveGoalTags(t.goal_ids)) {
        db.insert(experimentTaskGoal)
          .values({ experimentTaskId: task.id, goalId })
          .onConflictDoNothing()
          .run();
      }
    }

    for (const h of plan.habit_blocks) {
      createHabit({
        title: h.title,
        note: h.note ?? null,
        valence: h.valence,
        status: "building", // graduates to established only on experiment success
        rrule: h.rrule,
        preferredTime: h.preferred_time,
        durationMinutes: h.duration_minutes,
        experimentId,
        origin: "experiment",
        goalIds: resolveGoalTags(h.goal_ids), // joins the goals' ideal sets (goalHabit)
      });
    }
  });

  emit("experiment", experimentId, "experiment_running", {
    tasks: plan.tasks.length,
    habitBlocks: plan.habit_blocks.length,
  });
  return { ok: true, experiment: updated! };
}

// running → succeeded | failed. Blame-free either way: verdict + optional
// self-reported notes; failing with honest improvement notes IS the design.
export function endExperiment(
  id: string,
  verdict: "succeeded" | "failed",
  outcomeMd?: string,
): { ok: boolean; error?: string } {
  const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
  if (!row) return { ok: false, error: "experiment not found" };
  if (row.kind !== "actionable") return { ok: false, error: "raw experiment candidates cannot be ended" };
  if (row.status !== "running") return { ok: false, error: `experiment is ${row.status}, not running` };

  db.transaction(() => {
    db.update(experiment)
      .set({ status: verdict, endedAt: new Date().toISOString(), outcomeMd: outcomeMd ?? null, reviewMd: outcomeMd ?? null })
      .where(eq(experiment.id, id))
      .run();

    // Only complete success means the habits truly took.
    if (verdict === "succeeded") graduateExperimentHabits(id);
    else lapseExperimentHabits(id);

    // Open tasks resolve blamelessly on failure; on success they stay as the
    // user left them (done/skipped is the user's own record).
    if (verdict === "failed") {
      db.update(experimentTask)
        .set({ status: "skipped" })
        .where(
          and(
            eq(experimentTask.experimentId, id),
            inArray(experimentTask.status, ["pending", "scheduled"]),
          ),
        )
        .run();
    }

    // The outcome note becomes evidence on every linked goal.
    if (outcomeMd) {
      for (const goalId of goalIdsFor(id)) {
        db.insert(goalEvidence)
          .values({ goalId, note: `experiment "${row.title}" ${verdict}: ${outcomeMd}` })
          .run();
      }
    }
  });

  emit("experiment", id, "experiment_ended", { verdict, outcomeMd });
  return { ok: true };
}

// queued → archived: the shame-free escape hatch for candidates that no
// longer speak to you.
export function archiveExperiment(id: string): { ok: boolean; error?: string } {
  const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
  if (!row) return { ok: false, error: "experiment not found" };
  if (row.status !== "queued") return { ok: false, error: `experiment is ${row.status}, not queued` };
  db.update(experiment).set({ status: "archived" }).where(eq(experiment.id, id)).run();
  emit("experiment", id, "experiment_archived", {});
  return { ok: true };
}

const DEFAULT_ACTIONABLE_TASK_DURATION_MINUTES = 60;
const DEFAULT_ACTIONABLE_HABIT_DURATION_MINUTES = 15;
const DEFAULT_ACTIONABLE_HABIT_TIME = "09:00";

type ScheduleConfirmation =
  | {
      ok: true;
      experiment: ExperimentRow;
      calendarEvents: number;
      pushed: number;
    }
  | { ok: false; error: string };

function validPreferredTime(value: string | null): string {
  return value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : DEFAULT_ACTIONABLE_HABIT_TIME;
}

// A reviewed weekly actionable already owns its task and habit rows when the
// change set is applied. This is deliberately not `commitPlan`: it merely
// activates those existing rows and creates calendar mappings for the subset
// the user explicitly marked calendar-backed. It never creates a second task,
// habit, experience, or witness-facing record.
export async function confirmActionableSchedule(id: string): Promise<ScheduleConfirmation> {
  let updated: ExperimentRow | null = null;
  const eventIds: string[] = [];

  try {
    db.transaction(() => {
      const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
      if (!row) throw new Error("experiment not found");
      if (row.kind !== "actionable" || !row.experimentGroupId) {
        throw new Error("only a reviewed weekly actionable can be schedule-confirmed");
      }
      const group = db.select().from(experimentGroup).where(eq(experimentGroup.id, row.experimentGroupId)).get();
      if (!group || group.status !== "active") {
        throw new Error("the actionable's change group is no longer active");
      }
      if (row.status !== "queued") throw new Error(`experiment is ${row.status}, not queued`);

      const live = liveExperiment();
      if (live) {
        throw new Error(`"${live.title}" is ${live.status} — one experiment at a time; end or cancel it first`);
      }

      const tasks = db
        .select()
        .from(experimentTask)
        .where(eq(experimentTask.experimentId, row.id))
        .all();
      for (const task of tasks) {
        if (task.scheduleMode !== "calendar" || !task.scheduledFor) continue;
        const existing = db
          .select({ id: calendarEvent.id })
          .from(calendarEvent)
          .where(and(eq(calendarEvent.entityType, "experiment_task"), eq(calendarEvent.entityId, task.id)))
          .get();
        if (!existing) {
          const start = new Date(task.scheduledFor);
          if (Number.isNaN(start.getTime())) continue; // tolerate malformed legacy task rows without creating a bad event
          const event = db
            .insert(calendarEvent)
            .values({
              entityType: "experiment_task",
              entityId: task.id,
              title: task.title,
              startAt: start.toISOString(),
              endAt: new Date(start.getTime() + DEFAULT_ACTIONABLE_TASK_DURATION_MINUTES * 60_000).toISOString(),
              blockStyle: "task",
            })
            .returning()
            .get();
          eventIds.push(event.id);
        }
        if (task.status === "pending") {
          db.update(experimentTask).set({ status: "scheduled" }).where(eq(experimentTask.id, task.id)).run();
        }
      }

      // Organized draft application represents an unscheduled habit by
      // clearing its rrule. Existing rrule-bearing rows are therefore the
      // only habit blocks eligible for calendar confirmation.
      const habits = db.select().from(habit).where(eq(habit.experimentId, row.id)).all();
      for (const block of habits) {
        if (!block.rrule || !row.weekOf) continue;
        const existing = db
          .select({ id: calendarEvent.id })
          .from(calendarEvent)
          .where(and(eq(calendarEvent.entityType, "habit"), eq(calendarEvent.entityId, block.id)))
          .get();
        if (existing) continue;
        const startAt = zonedIso(
          getConfig<string>("TIMEZONE"),
          row.weekOf,
          hhmmToMin(validPreferredTime(block.preferredTime)),
        );
        const start = new Date(startAt);
        const event = db
          .insert(calendarEvent)
          .values({
            entityType: "habit",
            entityId: block.id,
            title: block.title,
            startAt,
            endAt: new Date(
              start.getTime() + (block.durationMinutes ?? DEFAULT_ACTIONABLE_HABIT_DURATION_MINUTES) * 60_000,
            ).toISOString(),
            rrule: block.rrule,
            blockStyle: "experiment",
          })
          .returning()
          .get();
        eventIds.push(event.id);
      }

      updated = db
        .update(experiment)
        .set({
          status: "running",
          startedAt: new Date().toISOString(),
          plannedDurationDays: row.plannedDurationDays ?? 7,
        })
        .where(eq(experiment.id, row.id))
        .returning()
        .get();
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let pushed = 0;
  if (isConnected()) {
    for (const eventId of eventIds) {
      try {
        await pushEvent(eventId);
        pushed++;
      } catch (error) {
        emit("calendar_event", eventId, "push_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  emit("experiment", id, "actionable_schedule_confirmed", { calendarEvents: eventIds.length, pushed });
  return { ok: true, experiment: updated!, calendarEvents: eventIds.length, pushed };
}

export function patchTask(taskId: string, status: "pending" | "scheduled" | "done" | "skipped") {
  const existing = db
    .select({ task: experimentTask, kind: experiment.kind })
    .from(experimentTask)
    .innerJoin(experiment, eq(experiment.id, experimentTask.experimentId))
    .where(eq(experimentTask.id, taskId))
    .get();
  if (!existing || existing.kind !== "actionable") return null;
  const updated = db
    .update(experimentTask)
    .set({ status })
    .where(eq(experimentTask.id, taskId))
    .returning()
    .get();
  emit("experiment_task", taskId, "task_status_changed", { from: existing.task.status, to: status });
  return updated;
}

// (The per-task copy-prompt is gone — talking through execution happens
// in-app now; see routes/shaping.ts for the experiment-level conversation.)
