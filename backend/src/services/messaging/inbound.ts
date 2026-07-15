import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db";
import { experiment, experimentGoal, goalEvidence, inboundMessage, witness } from "../../db/schema";
import { getConfig } from "../config";
import { emit } from "../events";

// Inbound routing for the messenger daemon. The relay never free-chats: the
// only inbound behaviors are the JOIN handshake, the friend's tuning commands
// (mute/less/more), and capturing the user's own replies as evidence. Anything
// else is stored and left alone.

export interface InboundPayload {
  chatId: string;
  senderHandle: string;
  text: string;
  sentAt?: string;
  messageId?: string;
}

// The user's own handle (phone/email), so their group replies are told apart
// from the friend's. Config, not env: it's personal data, editable in daylight.
function isUserHandle(handle: string): boolean {
  const mine = getConfig<string | null>("USER_IMESSAGE_HANDLE");
  return mine !== null && mine.trim() !== "" && normalize(handle) === normalize(mine);
}

function normalize(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9@.+]/g, "");
}

export function handleInbound(payload: InboundPayload): {
  action: "deduped" | "linked" | "muted" | "cadence" | "evidence" | "stored";
  witnessId?: string;
} {
  // Dedupe redeliveries (reconnects re-yield recent messages).
  if (payload.messageId) {
    const seen = db
      .select({ id: inboundMessage.id })
      .from(inboundMessage)
      .where(eq(inboundMessage.transportMessageId, payload.messageId))
      .get();
    if (seen) return { action: "deduped" };
  }

  const linked = db.select().from(witness).where(eq(witness.chatId, payload.chatId)).get() ?? null;
  const fromUser = isUserHandle(payload.senderHandle);

  const row = db
    .insert(inboundMessage)
    .values({
      witnessId: linked?.id ?? null,
      chatId: payload.chatId,
      senderHandle: payload.senderHandle,
      fromUser,
      text: payload.text,
      transportMessageId: payload.messageId ?? null,
    })
    .returning()
    .get();

  // Unknown chat: the only thing we listen for is the JOIN handshake —
  // "JOIN <code>" links this chat to the invited witness with that code.
  if (!linked) {
    const join = payload.text.trim().match(/^join\s+([a-z0-9-]{4,})$/i);
    if (join) {
      const code = join[1]!.toUpperCase();
      const invited = db
        .select()
        .from(witness)
        .where(and(eq(witness.inviteCode, code), isNull(witness.chatId), isNotNull(witness.handle)))
        .get();
      if (invited) {
        db.update(witness)
          .set({ chatId: payload.chatId, linkedAt: new Date().toISOString(), status: "active", linkRequestedAt: null })
          .where(eq(witness.id, invited.id))
          .run();
        markProcessed(row.id);
        emit("witness", invited.id, "witness_chat_linked", { via: "join_code", chatId: payload.chatId });
        return { action: "linked", witnessId: invited.id };
      }
    }
    return { action: "stored" };
  }

  // Friend tuning commands — friend annoyance is valid feedback.
  if (!fromUser) {
    const text = payload.text.trim().toLowerCase();
    const mute = text.match(/^mute\s+(\d+)([dw])$/);
    if (mute) {
      const days = Number(mute[1]) * (mute[2] === "w" ? 7 : 1);
      const until = new Date(Date.now() + days * 86_400_000).toISOString();
      db.update(witness).set({ mutedUntil: until }).where(eq(witness.id, linked.id)).run();
      markProcessed(row.id);
      emit("witness", linked.id, "witness_muted", { until });
      return { action: "muted", witnessId: linked.id };
    }
    if (text === "less" || text === "more") {
      const delta = text === "less" ? 3 : -2;
      const cadence = Math.min(30, Math.max(2, linked.promptCadenceDays + delta));
      db.update(witness).set({ promptCadenceDays: cadence }).where(eq(witness.id, linked.id)).run();
      markProcessed(row.id);
      emit("witness", linked.id, "witness_cadence_tuned", { cadence });
      return { action: "cadence", witnessId: linked.id };
    }
    return { action: "stored", witnessId: linked.id };
  }

  // The user's own substantive reply in a witness chat → evidence on the live
  // experiment's goals. The friend asked; the answer is diagnostic material.
  if (payload.text.trim().length >= 20) {
    const running = db.select().from(experiment).where(eq(experiment.status, "running")).get();
    if (running) {
      const goals = db
        .select({ goalId: experimentGoal.goalId })
        .from(experimentGoal)
        .where(eq(experimentGoal.experimentId, running.id))
        .all();
      for (const g of goals) {
        db.insert(goalEvidence)
          .values({ goalId: g.goalId, note: `(said to ${linked.name} in the witness chat) ${payload.text.trim()}` })
          .run();
      }
      markProcessed(row.id);
      emit("witness", linked.id, "witness_reply_captured", { experimentId: running.id });
      return { action: "evidence", witnessId: linked.id };
    }
  }
  return { action: "stored", witnessId: linked.id };
}

function markProcessed(id: string) {
  db.update(inboundMessage).set({ processedAt: new Date().toISOString() }).where(eq(inboundMessage.id, id)).run();
}
