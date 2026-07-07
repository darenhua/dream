import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { experiment, goalEvidence } from "../db/schema";
import { ExperimentDraft, type ExperimentDraftT } from "../domain/schemas";
import { getConfig } from "./config";
import { emit } from "./events";
import {
  budgetMd,
  experimentHistoryMd,
  goalsAllMd,
  registriesMd,
} from "./projector";

// §7.7 — service-enforced invariant: ≤1 row in {committed, running}.
export function liveExperiment() {
  return (
    db
      .select()
      .from(experiment)
      .where(inArray(experiment.status, ["committed", "running"]))
      .get() ?? null
  );
}

export function currentExperiment() {
  // Live one, else the latest by creation — the dashboard card never blanks.
  const live = liveExperiment();
  const row =
    live ??
    db.select().from(experiment).orderBy(desc(experiment.createdAt)).limit(1).get() ??
    null;
  if (!row) return null;
  const daysRunning = row.committedAt
    ? Math.floor((Date.now() - new Date(row.committedAt).getTime()) / 86_400_000)
    : null;
  return { ...row, daysRunning, isLive: row.status === "committed" || row.status === "running" };
}

// §8.6.1 — refuses while an experiment is live; ending one unblocks this.
export function getPromptPackage(): { ok: true; markdown: string } | { ok: false; error: string } {
  const live = liveExperiment();
  if (live) {
    return {
      ok: false,
      error: `an experiment is live ("${live.title}") — end or compost it first`,
    };
  }
  const template = getConfig<string>("PROMPT.experiment_package");
  const state = [goalsAllMd(), registriesMd(), experimentHistoryMd(), budgetMd()].join("\n\n---\n\n");
  return { ok: true, markdown: template.replace("[STATE]", `\n\n${state}`) };
}

// §8.6.2 — zod-validates the pasted JSON; field-level errors for the dashboard.
export function createDraft(
  pasted: unknown,
): { ok: true; experiment: typeof experiment.$inferSelect } | { ok: false; fieldErrors: Record<string, string[]> } {
  const parsed = ExperimentDraft.safeParse(pasted);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "(root)";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { ok: false, fieldErrors };
  }
  const d: ExperimentDraftT = parsed.data;
  const row = db
    .insert(experiment)
    .values({
      title: d.title,
      reasoningMd: d.reasoning_md,
      goalIds: JSON.stringify(d.goal_ids),
      leversJson: JSON.stringify(d.levers_json),
      actionsJson: JSON.stringify(d.actions_json),
      bandwidth: d.bandwidth,
      status: "draft",
    })
    .returning()
    .get();
  emit("experiment", row.id, "experiment_drafted", { title: row.title });
  return { ok: true, experiment: row };
}

// §8.6.3 — draft → committed → running in one call; committed is an event boundary.
export function commitExperiment(id: string): { ok: boolean; error?: string } {
  const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
  if (!row) return { ok: false, error: "experiment not found" };
  if (row.status !== "draft") return { ok: false, error: `experiment is ${row.status}, not draft` };
  if (liveExperiment()) return { ok: false, error: "another experiment is already live (≤1 rule)" };

  const now = new Date().toISOString();
  db.update(experiment)
    .set({ status: "committed", committedAt: now })
    .where(eq(experiment.id, id))
    .run();
  emit("experiment", id, "experiment_committed", {});
  db.update(experiment).set({ status: "running" }).where(eq(experiment.id, id)).run();
  emit("experiment", id, "experiment_running", {});
  return { ok: true };
}

// §8.6.4 — done and composted are the same single call; composting is never
// more work than finishing (the zombie-experiment defense).
export function endExperiment(
  id: string,
  verdict: "done" | "composted",
  outcomeMd?: string,
  compostWhy?: string,
): { ok: boolean; error?: string } {
  const row = db.select().from(experiment).where(eq(experiment.id, id)).get();
  if (!row) return { ok: false, error: "experiment not found" };
  if (row.status !== "committed" && row.status !== "running") {
    return { ok: false, error: `experiment is ${row.status}, not live` };
  }

  const note = verdict === "composted" ? (compostWhy ?? outcomeMd) : outcomeMd;
  db.update(experiment)
    .set({
      status: verdict,
      endedAt: new Date().toISOString(),
      outcomeMd: note ?? null,
    })
    .where(eq(experiment.id, id))
    .run();

  // The optional one-liner becomes evidence on the linked goals (§8.6.4).
  if (note) {
    const goalIds = JSON.parse(row.goalIds) as string[];
    for (const goalId of goalIds) {
      db.insert(goalEvidence)
        .values({ goalId, note: `experiment "${row.title}" ${verdict}: ${note}` })
        .run();
    }
  }
  emit("experiment", id, "experiment_ended", { verdict, note });
  return { ok: true };
}

export function experimentHistory() {
  return db
    .select()
    .from(experiment)
    .where(inArray(experiment.status, ["done", "composted"]))
    .orderBy(desc(experiment.endedAt))
    .all();
}
