import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chatMessage, chatSession, conversation, experiment } from "../db/schema";
import { emit } from "./events";

// The in-app replacement for the copy-a-prompt-into-Claude loop: shaping the
// next experiment is an L3 conversation (no tools, no structured plan — a
// rant-like dig). Finishing converts the transcript into a normal `conversation`
// row that enters the same distill → confirm → derive pipeline as any rant.
// The system still never designs experiments from scratch; it helps the user
// rant productively — just without leaving the app.

function hashContent(contentJson: string): string {
  return new Bun.CryptoHasher("sha256").update(contentJson).digest("hex");
}

export function startShaping(): { sessionId: string; opener: string } {
  const running = db
    .select()
    .from(experiment)
    .where(and(eq(experiment.kind, "actionable"), eq(experiment.status, "running")))
    .get();
  const queued = db
    .select({ id: experiment.id })
    .from(experiment)
    .where(and(eq(experiment.kind, "actionable"), inArray(experiment.status, ["queued", "scheduling"])))
    .all().length;

  // Deterministic opener — context-aware but zero LLM spend. The real
  // conversation starts when the user answers.
  const opener = running
    ? `"${running.title}" is winding down and ${queued === 0 ? "nothing's queued behind it" : "the queue has company"}. What's been itching lately — what change would actually help right now?`
    : queued === 0
      ? "The engine's empty — no experiment running, nothing queued. No pressure to be organized about it: what's been bugging you or pulling at you lately?"
      : "Something's already queued, but if a different itch is louder, let's hear it. What's on your mind?";

  const session = db
    .insert(chatSession)
    .values({ purpose: "experiment_shaping", status: "open" })
    .returning()
    .get();
  db.insert(chatMessage).values({ sessionId: session.id, role: "assistant", content: opener }).run();
  emit("chat_session", session.id, "shaping_started", {});
  return { sessionId: session.id, opener };
}

// Finish = the transcript becomes an accepted rant. The caller kicks distill
// (kept out of here so tests run without an agent).
export function finishShaping(sessionId: string): { conversationId: string } {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) throw new Error(`session ${sessionId} not found`);
  if (session.purpose !== "experiment_shaping") throw new Error("not a shaping session");
  if (session.status !== "open") throw new Error(`session is ${session.status}`);

  const messages = db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(asc(chatMessage.createdAt))
    .all();
  const userMessages = messages.filter(m => m.role === "user");
  if (userMessages.length === 0) throw new Error("nothing to keep — say something first");

  const now = new Date().toISOString();
  const transcript = messages.map(m => ({ role: m.role, content: m.content, ts: m.createdAt }));
  const contentJson = JSON.stringify(transcript);
  const title = `shaping: ${userMessages[0]!.content.slice(0, 60)}`;

  const convo = db
    .insert(conversation)
    .values({
      source: "in_app",
      externalId: `shaping-${sessionId}`,
      title,
      contentJson,
      rawJson: contentJson,
      contentHash: hashContent(contentJson),
      sourceCreatedAt: messages[0]!.createdAt,
      sourceUpdatedAt: now,
      // The user chose to have this conversation — it enters pre-accepted.
      rantVerdict: "candidate",
      rantStatus: "accepted",
      rantDetectedAt: now,
      rantResolvedAt: now,
      detectorNote: "in-app shaping conversation",
      distillRequested: true,
    })
    .returning({ id: conversation.id })
    .get();

  db.update(chatSession).set({ status: "committed" }).where(eq(chatSession.id, sessionId)).run();
  emit("conversation", convo.id, "shaping_finished", { sessionId });
  return { conversationId: convo.id };
}

export function cancelShaping(sessionId: string): boolean {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session || session.status !== "open") return false;
  db.update(chatSession).set({ status: "cancelled" }).where(eq(chatSession.id, sessionId)).run();
  emit("chat_session", sessionId, "shaping_cancelled", {});
  return true;
}
