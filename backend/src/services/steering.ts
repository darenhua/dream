import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { chatMessage, chatSession, conversation, extraction, goal, goalEvidence, proposal } from "../db/schema";
import type { TranscriptMessage } from "../domain/parser";
import { DistillerOutput, GoalEditOutput } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { getConfig } from "./config";
import { emit } from "./events";
import { newWorkspace, projectDistill, projectSteerRevision, stateMd } from "./projector";
import { applyRevision } from "./revise";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The universal EDIT next to accept/deny. A steer session is an L3 chat
// anchored to one generation (distill run / pending proposal / ratified goal):
// its context carries the ORIGINAL generation's instructions, inputs, and
// output, so the conversation knows the job, sees what came out, and the
// user's complaints land with full context. Finishing re-runs that same
// generation with the chat as steering hints and REPLACES the artifact in
// place — unconfirmed extractions swapped, the same proposal row updated,
// the same goal patched. Never a duplicate.
//
// Membrane note: distill output and pending proposals are agent-owned drafts.
// A ratified goal is human-owned — the steer result applies only on the
// user's explicit finish click, which IS the ratification (same standing as
// the manual PATCH endpoint).

export type SteerTarget = "distill" | "proposal" | "goal";

type SessionRow = typeof chatSession.$inferSelect;

function targetRow(targetType: SteerTarget, targetId: string) {
  switch (targetType) {
    case "distill":
      return db.select().from(conversation).where(eq(conversation.id, targetId)).get() ?? null;
    case "proposal":
      return db.select().from(proposal).where(eq(proposal.id, targetId)).get() ?? null;
    case "goal":
      return db.select().from(goal).where(eq(goal.id, targetId)).get() ?? null;
  }
}

export function startSteer(targetType: SteerTarget, targetId: string): { sessionId: string; opener: string } {
  const row = targetRow(targetType, targetId);
  if (!row) throw new Error(`${targetType} target ${targetId} not found`);
  if (targetType === "distill") {
    const convo = row as typeof conversation.$inferSelect;
    if (!convo.distilledAt) throw new Error("nothing to steer — this conversation hasn't been distilled yet");
  }
  if (targetType === "proposal") {
    const p = row as typeof proposal.$inferSelect;
    if (p.status !== "pending") throw new Error(`proposal is ${p.status} — only pending proposals steer`);
  }

  const opener = {
    distill:
      "This is the extraction pass for that conversation — everything it pulled is in my context, alongside the transcript. What's off? Wrong splits, missed passages, wrong register, things that shouldn't be there — tell me and I'll redo the pass your way.",
    proposal:
      "I have the pending proposal, its citations, and the rules it was generated under. What should be different — framing, depth, what it draws on, what it claims? When you're happy, finish regenerates it in place.",
    goal:
      "I have this goal's full record and the evidence behind it. Tell me what reads wrong — the identity clause, the synthesis, what it emphasizes. Finishing rewrites the record; nothing applies until you hit it.",
  }[targetType];

  const session = db
    .insert(chatSession)
    .values({ purpose: "steer", targetType, targetId, status: "open" })
    .returning()
    .get();
  db.insert(chatMessage).values({ sessionId: session.id, role: "assistant", content: opener }).run();
  emit("chat_session", session.id, "steer_started", { targetType, targetId });
  return { sessionId: session.id, opener };
}

// The chat's system context: original instructions + original inputs +
// current output, per target. Rebuilt fresh each turn (projector-style).
export function steerContextMd(session: SessionRow): string {
  if (!session.targetType || !session.targetId) throw new Error("steer session has no target");
  const row = targetRow(session.targetType, session.targetId);
  if (!row) throw new Error("steer target vanished");

  switch (session.targetType) {
    case "distill": {
      const convo = row as typeof conversation.$inferSelect;
      const current = db
        .select()
        .from(extraction)
        .where(eq(extraction.conversationId, convo.id))
        .orderBy(asc(extraction.createdAt))
        .all();
      const messages: TranscriptMessage[] = convo.contentJson ? JSON.parse(convo.contentJson) : [];
      const transcript = messages
        .map((m, i) => `**[${i}] ${m.role === "user" ? "me" : "claude"}:** ${m.content.slice(0, 800)}`)
        .join("\n\n");
      return (
        `# The generation being steered: extraction (distill)\n\n## Its original instructions\n\n${getConfig<string>("PROMPT.distiller")}\n\n` +
        `# The conversation (its input)\n\n${transcript}\n\n` +
        `# What it currently produced\n\n${
          current.length
            ? current
                .map(
                  x =>
                    `- ${x.confirmedAt ? "[CONFIRMED — frozen, will survive the redo] " : ""}**${x.kind}**: ${x.text}`,
                )
                .join("\n")
            : "_(no extractions)_"
        }`
      );
    }
    case "proposal": {
      const p = row as typeof proposal.$inferSelect;
      const payload = JSON.parse(p.payloadJson) as { extraction_ids?: string[] };
      const cited = payload.extraction_ids?.length
        ? db.select().from(extraction).all().filter(x => payload.extraction_ids!.includes(x.id))
        : [];
      return (
        `# The generation being steered: a pending ${p.kind} proposal\n\n## The rules it was generated under\n\n${getConfig<string>("PROMPT.deriver")}\n\n` +
        `# The proposal as it stands\n\n\`\`\`json\n${JSON.stringify(JSON.parse(p.payloadJson), null, 2)}\n\`\`\`\n\n` +
        `# The extractions it cites (its evidence)\n\n${cited.map(x => `- \`${x.id}\` **${x.kind}**: ${x.text}`).join("\n") || "_(none)_"}\n\n${stateMd()}`
      );
    }
    case "goal": {
      const g = row as typeof goal.$inferSelect;
      const evidence = db
        .select()
        .from(goalEvidence)
        .where(eq(goalEvidence.goalId, g.id))
        .orderBy(asc(goalEvidence.createdAt))
        .all();
      return (
        `# The record being steered: a ratified goal\n\n## What a goal record must read like\n\n${getConfig<string>("PROMPT.deriver")}\n\n` +
        `# The goal as it stands\n\n**title:** ${g.title}\n**identity clause:** ${g.identityClause ?? "(none)"}\n**status:** ${g.status}\n\n## Synthesis\n\n${g.synthesisMd ?? "_(none)_"}\n\n` +
        `# Its evidence trail\n\n${evidence.map(e => `- ${e.note ?? ""}`).join("\n") || "_(none)_"}`
      );
    }
  }
}

function steeringNotes(sessionId: string): string {
  const messages = db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(asc(chatMessage.createdAt))
    .all();
  if (!messages.some(m => m.role === "user")) throw new Error("say what should change first");
  return messages.map(m => `${m.role === "user" ? "USER" : "AGENT"}: ${m.content}`).join("\n\n");
}

const HINT_PREFIX =
  "# Steering conversation (the user reviewed the previous output — this is what must change; it overrides your defaults where they conflict)\n\n";

// Finish = redo the original generation with the steering as hints, replacing
// the artifact in place. Returns a per-target summary for the UI.
export async function finishSteer(
  sessionId: string,
): Promise<{ targetType: SteerTarget; targetId: string; result: unknown }> {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) throw new Error(`session ${sessionId} not found`);
  if (session.purpose !== "steer") throw new Error("not a steer session");
  if (session.status !== "open") throw new Error(`session is ${session.status}`);
  if (!session.targetType || !session.targetId) throw new Error("steer session has no target");

  const hints = HINT_PREFIX + steeringNotes(sessionId);
  const targetType = session.targetType as SteerTarget;
  const targetId = session.targetId;
  let result: unknown;

  switch (targetType) {
    case "distill": {
      const convo = db.select().from(conversation).where(eq(conversation.id, targetId)).get();
      if (!convo) throw new Error("conversation not found");
      const dir = newWorkspace("distiller");
      projectDistill(targetId, dir);
      const run = await runStructured("distiller", dir, DistillerOutput, { trigger: "manual", hints });
      if (run.status !== "ok" || !run.output) throw new Error(`redo failed: ${run.error}`);
      // Idempotent replace: unconfirmed rows swap out; confirmed rows are
      // immutable facts and survive.
      db.delete(extraction)
        .where(and(eq(extraction.conversationId, targetId), isNull(extraction.confirmedAt)))
        .run();
      for (const x of run.output.extractions) {
        db.insert(extraction)
          .values({
            conversationId: targetId,
            kind: x.kind,
            text: x.text,
            startIdx: x.start_idx,
            endIdx: x.end_idx,
            contentHash: convo.contentHash ?? "",
            origin: "agent",
            agentRunId: run.runId,
          })
          .run();
      }
      db.update(conversation)
        .set({ distilledAt: new Date().toISOString() })
        .where(eq(conversation.id, targetId))
        .run();
      emit("conversation", targetId, "distill_steered", { agentRunId: run.runId, extractions: run.output.extractions.length });
      result = { extractions: run.output.extractions.length };
      break;
    }
    case "proposal": {
      const p = db.select().from(proposal).where(eq(proposal.id, targetId)).get();
      if (!p) throw new Error("proposal not found");
      if (p.status !== "pending") throw new Error(`proposal is ${p.status}, not pending`);
      const dir = newWorkspace("proposal_reviser");
      projectSteerRevision(p, dir);
      const { ReviserOutput } = await import("../domain/schemas");
      const run = await runStructured("proposal_reviser", dir, ReviserOutput, { trigger: "manual", hints });
      if (run.status !== "ok" || !run.output) throw new Error(`redo failed: ${run.error}`);
      const applied = applyRevision(p, run.output);
      if (!applied.ok) throw new Error(applied.error);
      emit("proposal", targetId, "proposal_steered", { agentRunId: run.runId });
      result = { kind: p.kind };
      break;
    }
    case "goal": {
      const g = db.select().from(goal).where(eq(goal.id, targetId)).get();
      if (!g) throw new Error("goal not found");
      const dir = newWorkspace("goal_editor");
      writeFileSync(join(dir, "goal.md"), steerContextMd(session));
      const run = await runStructured("goal_editor", dir, GoalEditOutput, { trigger: "manual", hints });
      if (run.status !== "ok" || !run.output) throw new Error(`redo failed: ${run.error}`);
      // Applied on the user's explicit finish click — that click is the
      // ratification, same standing as the manual PATCH.
      db.update(goal)
        .set({
          title: run.output.title,
          identityClause: run.output.identity_clause,
          synthesisMd: run.output.synthesis_md,
        })
        .where(eq(goal.id, targetId))
        .run();
      db.insert(goalEvidence)
        .values({ goalId: targetId, note: "record rewritten via steering conversation" })
        .run();
      emit("goal", targetId, "goal_steered", { agentRunId: run.runId });
      result = { title: run.output.title };
      break;
    }
  }

  db.update(chatSession).set({ status: "committed" }).where(eq(chatSession.id, sessionId)).run();
  return { targetType, targetId, result };
}

export function cancelSteer(sessionId: string): boolean {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session || session.status !== "open") return false;
  db.update(chatSession).set({ status: "cancelled" }).where(eq(chatSession.id, sessionId)).run();
  emit("chat_session", sessionId, "steer_cancelled", {});
  return true;
}
