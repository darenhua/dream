import { desc, eq, inArray } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import {
  chatMessage,
  chatSession,
  experiment,
  experimentTask,
  goal,
  goalEvidence,
  habit,
  reviewWriteup,
} from "../db/schema";
import { ReviewWriteupOutput, WitnessShareOutput } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { emit } from "./events";
import { goalIdsFor } from "./experiments";
import { enqueueOutbound } from "./outbox";
import { newWorkspace } from "./projector";
import { listWitnesses, scopedGoalIds } from "./witnesses";
import { visibleExperimentIds, witnessContextMd } from "./witnessScope";

// The review artifact: drafted by an agent from the run's evidence, edited by
// the human, frozen at approve. Approval fans out per-witness goal-filtered
// shares into the outbox — the manual protocol's copy text and the future
// transport's payload are the same rows.

export function getReview(experimentId: string) {
  return db.select().from(reviewWriteup).where(eq(reviewWriteup.experimentId, experimentId)).get() ?? null;
}

function projectReview(experimentId: string, dir: string, interviewMd?: string) {
  const e = db.select().from(experiment).where(eq(experiment.id, experimentId)).get();
  if (!e) throw new Error(`experiment ${experimentId} not found`);
  const goalRows = db.select().from(goal).where(inArray(goal.id, goalIdsFor(experimentId).length ? goalIdsFor(experimentId) : ["-"])).all();
  const tasks = db.select().from(experimentTask).where(eq(experimentTask.experimentId, experimentId)).all();
  const habits = db.select().from(habit).where(eq(habit.experimentId, experimentId)).all();
  const evidence = goalRows.length
    ? db.select().from(goalEvidence).where(inArray(goalEvidence.goalId, goalRows.map(g => g.id))).orderBy(desc(goalEvidence.createdAt)).limit(30).all()
    : [];

  writeFileSync(
    join(dir, "experiment.md"),
    `# ${e.title}\n\nstatus: ${e.status}\nstarted: ${e.startedAt ?? "?"}\nended: ${e.endedAt ?? "?"}\nplanned days: ${e.plannedDurationDays ?? "?"}\n\n## Hypothesis\n${e.hypothesisMd ?? "_(none)_"}\n\n## The user's end-of-run notes\n${e.outcomeMd ?? "_(none)_"}\n\n## Target goals\n${goalRows.map(g => `- ${g.title}${g.identityClause ? ` — ${g.identityClause}` : ""}`).join("\n")}`,
  );
  writeFileSync(
    join(dir, "outcomes.md"),
    `# Task end-states\n${tasks.map(t => `- [${t.status}] ${t.title}${t.detail ? ` — ${t.detail}` : ""}`).join("\n") || "_(no tasks)_"}\n\n# Habits from this run\n${habits.map(h => `- [${h.status}] ${h.title}${h.note ? ` — ${h.note}` : ""}`).join("\n") || "_(no habits)_"}\n\n# Evidence on the target goals (newest first)\n${evidence.map(ev => `- ${ev.note}`).join("\n") || "_(none)_"}`,
  );
  if (interviewMd) writeFileSync(join(dir, "interview.md"), interviewMd);
}

export async function generateDraft(experimentId: string, trigger: "daily" | "manual") {
  const e = db.select().from(experiment).where(eq(experiment.id, experimentId)).get();
  if (!e) throw new Error(`experiment ${experimentId} not found`);
  if (e.kind !== "actionable") throw new Error("raw experiment candidates do not receive review writeups");
  if (e.status !== "succeeded" && e.status !== "failed") {
    throw new Error(`experiment is ${e.status} — reviews are written after it ends`);
  }
  const existing = getReview(experimentId);
  if (existing?.status === "approved") throw new Error("review already approved — it is frozen");

  const dir = newWorkspace("review_writeup");
  projectReview(experimentId, dir, interviewTranscriptMd(experimentId) ?? undefined);
  const run = await runStructured("review_writeup", dir, ReviewWriteupOutput, { trigger });
  if (run.status !== "ok" || !run.output) {
    emit("experiment", experimentId, "review_draft_failed", { agentRunId: run.runId, error: run.error });
    return { status: run.status, error: run.error };
  }

  db.insert(reviewWriteup)
    .values({ experimentId, draftMd: run.output.review_md, status: "draft_ready", agentRunId: run.runId })
    .onConflictDoUpdate({
      target: reviewWriteup.experimentId,
      set: { draftMd: run.output.review_md, status: "draft_ready", agentRunId: run.runId },
    })
    .run();
  emit("experiment", experimentId, "review_draft_ready", { agentRunId: run.runId });
  return { status: "ok" as const, draftMd: run.output.review_md };
}

export function patchDraft(experimentId: string, draftMd: string) {
  const row = getReview(experimentId);
  if (!row || row.status === "approved") return null;
  return db
    .update(reviewWriteup)
    .set({ draftMd, status: "draft_ready" })
    .where(eq(reviewWriteup.experimentId, experimentId))
    .returning()
    .get();
}

// Approve: freeze the final text, then compose one share per in-scope
// witness. Leak rule, by construction: a witness whose scope covers ALL the
// experiment's goals gets the full writeup as composer input; a partial-scope
// witness's share is composed ONLY from their scoped projection — the raw
// writeup (which may mention out-of-scope life) never reaches that run.
export async function approveReview(experimentId: string, finalMd: string) {
  const row = getReview(experimentId);
  if (!row) throw new Error("no review draft to approve");
  if (row.status === "approved") throw new Error("review already approved");

  db.update(reviewWriteup)
    .set({ finalMd, status: "approved", approvedAt: new Date().toISOString() })
    .where(eq(reviewWriteup.experimentId, experimentId))
    .run();
  // The approved review becomes durable learning context for the next
  // manually initiated actionable MCP workspace.
  db.update(experiment).set({ reviewMd: finalMd }).where(eq(experiment.id, experimentId)).run();
  emit("experiment", experimentId, "review_approved", {});

  const experimentGoals = new Set(goalIdsFor(experimentId));
  const shares: Record<string, string> = {};
  for (const w of listWitnesses()) {
    if (w.status !== "active" && w.status !== "invited") continue;
    if (!visibleExperimentIds(w.id).includes(experimentId)) continue;

    const dir = newWorkspace("witness_composer");
    writeFileSync(join(dir, "witness-context.md"), witnessContextMd(w.id));
    const fullScope = [...experimentGoals].every(g => scopedGoalIds(w.id).includes(g));
    if (fullScope) writeFileSync(join(dir, "review.md"), finalMd);

    const run = await runStructured("witness_composer", dir, WitnessShareOutput, {
      trigger: "manual",
      hints: `Compose the review share for ${w.name}.${fullScope ? "" : " Their scope covers only part of this experiment — work strictly from witness-context.md."}`,
    });
    if (run.status !== "ok" || !run.output) {
      shares[w.name] = `composer failed: ${run.error}`;
      continue;
    }
    const enqueued = enqueueOutbound({
      witnessId: w.id,
      kind: "review_share",
      bodyText: run.output.body_text,
      contextJson: { follow_up_questions: run.output.follow_up_questions },
      relatedType: "review_writeup",
      relatedId: row.id,
      dedupeKey: `review_share:${experimentId}:${w.id}`,
    });
    shares[w.name] = enqueued ? "share pending approval" : "already shared";
  }
  return { ok: true as const, shares };
}

// --- the optional L3 interview ---

export function startInterview(experimentId: string): { sessionId: string } {
  const experimentRow = db.select().from(experiment).where(eq(experiment.id, experimentId)).get();
  if (!experimentRow) throw new Error(`experiment ${experimentId} not found`);
  if (experimentRow.kind !== "actionable") throw new Error("raw experiment candidates do not receive review interviews");
  const open = db
    .select()
    .from(chatSession)
    .where(eq(chatSession.experimentId, experimentId))
    .all()
    .find(s => s.purpose === "review_interview" && s.status === "open");
  if (open) return { sessionId: open.id };
  const row = db
    .insert(chatSession)
    .values({ purpose: "review_interview", experimentId, status: "open" })
    .returning()
    .get();
  emit("chat_session", row.id, "review_interview_opened", { experimentId });
  return { sessionId: row.id };
}

export function interviewTranscriptMd(experimentId: string): string | null {
  const sessions = db
    .select()
    .from(chatSession)
    .where(eq(chatSession.experimentId, experimentId))
    .all()
    .filter(s => s.purpose === "review_interview");
  if (sessions.length === 0) return null;
  const lines: string[] = ["# Review interview transcript\n"];
  for (const s of sessions) {
    const messages = db.select().from(chatMessage).where(eq(chatMessage.sessionId, s.id)).all();
    for (const m of messages) lines.push(`**${m.role === "user" ? "me" : "interviewer"}:** ${m.content}`);
  }
  return lines.length > 1 ? lines.join("\n\n") : null;
}

// Finish the interview: close the session and regenerate the draft with the
// transcript folded in.
export async function finishInterview(sessionId: string) {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session || session.purpose !== "review_interview") throw new Error("not a review interview session");
  if (!session.experimentId) throw new Error("interview has no experiment");
  db.update(chatSession).set({ status: "committed" }).where(eq(chatSession.id, sessionId)).run();
  return generateDraft(session.experimentId, "manual");
}
