import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  chatSession,
  experiment,
  experimentGoal,
  experimentTask,
  experimentTaskGoal,
  extraction,
  extractionLink,
  goalEvidence,
} from "../db/schema";
import type { SchedulePlanT } from "../domain/schemas";
import { getConfig } from "./config";
import { experimentRelations, extractionsFor } from "./entityDetail";
import { emit } from "./events";
import { createExperience } from "./experiences";
import { createHabit, graduateExperimentHabits, lapseExperimentHabits } from "./habits";

// The experiment FSM: queued → scheduling → running → succeeded | failed.
// Candidates enter the queue only via approved experiment_propose proposals;
// there is no draft state and no system nudge at any duration.

type ExperimentRow = typeof experiment.$inferSelect;

export function liveExperiment(): ExperimentRow | null {
  return (
    db
      .select()
      .from(experiment)
      .where(inArray(experiment.status, ["scheduling", "running"]))
      .get() ?? null
  );
}

// Called by the proposal apply-switch on approval.
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
  emit("experiment", row.id, "experiment_queued", { title: row.title });
  return row;
}

export function listQueue() {
  return db
    .select()
    .from(experiment)
    .where(inArray(experiment.status, ["queued", "scheduling"]))
    .orderBy(asc(experiment.queuedAt))
    .all();
}

export function currentExperiment() {
  // The running one, else the queue head — the feed card never blanks needlessly.
  const running = db.select().from(experiment).where(eq(experiment.status, "running")).get();
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
    .where(inArray(experiment.status, ["succeeded", "failed"]))
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
  if (row.status !== "running") return { ok: false, error: `experiment is ${row.status}, not running` };

  db.transaction(() => {
    db.update(experiment)
      .set({ status: verdict, endedAt: new Date().toISOString(), outcomeMd: outcomeMd ?? null })
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

export function patchTask(taskId: string, status: "pending" | "scheduled" | "done" | "skipped") {
  const existing = db.select().from(experimentTask).where(eq(experimentTask.id, taskId)).get();
  if (!existing) return null;
  const updated = db
    .update(experimentTask)
    .set({ status })
    .where(eq(experimentTask.id, taskId))
    .returning()
    .get();
  emit("experiment_task", taskId, "task_status_changed", { from: existing.status, to: status });
  return updated;
}

// (The per-task copy-prompt is gone — talking through execution happens
// in-app now; see routes/shaping.ts for the experiment-level conversation.)
