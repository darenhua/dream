import { and, eq, like } from "drizzle-orm";
import { db } from "../db";
import { conversation, conversationRecordLink } from "../db/schema";
import { emit } from "./events";
import { getRecordChangeSetByMarker, type AppliedRecord } from "./recordChangeSets";
import { modelTable, type VersionedModel } from "./records";

// The provenance spine (Phase 4): marker tokens in exported transcripts are
// matched to applied change sets, producing conversation_record_link rows and
// backfilled source_conversation_id columns. Runs in both directions —
// at import (conversation arrives after the records) and at apply
// (records arrive after the conversation was imported).

export const MARKER_PATTERN = /rc_[a-f0-9]{12}/g;

type Message = { role: string; content: string };

/** Everything before the marker's message is the slice (the marker lives in
 * the record_create tool result, i.e. the call message itself). */
function markerSliceEnd(messages: Message[], marker: string): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.content.includes(marker)) return i;
  }
  return null;
}

function stampSourceConversation(model: VersionedModel, versionId: string, conversationId: string) {
  const table = modelTable(model);
  const row = db.select().from(table).where(eq(table.id, versionId)).get();
  if (!row || row.sourceConversationId) return;
  db.update(table).set({ sourceConversationId: conversationId }).where(eq(table.id, versionId)).run();
}

function writeLinks(conversationId: string, marker: string, sliceEndIdx: number | null, applied: Record<string, AppliedRecord>) {
  // Idempotent per (conversation, marker): re-imports replace their links.
  db.delete(conversationRecordLink)
    .where(and(eq(conversationRecordLink.conversationId, conversationId), eq(conversationRecordLink.markerToken, marker)))
    .run();
  for (const record of Object.values(applied)) {
    // link_existing rows were not inserted by this change set; they are
    // "mentioned", not created, in this conversation.
    const role = record.verdict === "link_existing" ? "mentioned" : record.role === "central" ? "created_central" : "created_satellite";
    db.insert(conversationRecordLink)
      .values({
        conversationId,
        markerToken: marker,
        sliceEndIdx,
        recordType: record.model,
        recordVersionId: record.versionId,
        role,
      })
      .run();
    if (role !== "mentioned") stampSourceConversation(record.model, record.versionId, conversationId);
  }
}

/** Import-time direction: scan one imported conversation's messages for
 * marker tokens and stitch every applied change set found. */
export function stitchConversation(conversationId: string, messages: Message[]): number {
  const found = new Set<string>();
  for (const message of messages) {
    for (const match of message.content.matchAll(MARKER_PATTERN)) found.add(match[0]);
  }
  let stitched = 0;
  for (const marker of found) {
    const changeSet = getRecordChangeSetByMarker(marker);
    if (!changeSet?.appliedRecords) continue; // not applied (yet) — apply-time direction heals later
    writeLinks(conversationId, marker, markerSliceEnd(messages, marker), changeSet.appliedRecords);
    stitched++;
  }
  if (stitched) emit("conversation", conversationId, "conversation_stitched", { markers: stitched });
  return stitched;
}

/** Apply-time direction: the change set just got applied; if a conversation
 * containing its marker was already imported, stitch it now. */
export function stitchAppliedChangeSet(marker: string): number {
  const changeSet = getRecordChangeSetByMarker(marker);
  if (!changeSet?.appliedRecords) return 0;
  const rows = db
    .select()
    .from(conversation)
    .where(like(conversation.contentJson, `%${marker}%`))
    .all();
  let stitched = 0;
  for (const row of rows) {
    if (!row.contentJson) continue;
    const messages = JSON.parse(row.contentJson) as Message[];
    writeLinks(row.id, marker, markerSliceEnd(messages, marker), changeSet.appliedRecords);
    stitched++;
  }
  return stitched;
}
