import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { conversationRecordLink, organizedGoal } from "../src/db/schema";
import { parseConversation } from "../src/domain/parser";
import { ingestFile } from "../src/services/ingestion";
import { applyRecordChangeSet, createRecordChangeSet } from "../src/services/recordChangeSets";
import { readRecord } from "../src/services/recordReads";

beforeEach(() => wipeAllTables());

const ROOT = "00000000-0000-4000-8000-000000000000";

function exportedConversation(marker: string, externalId = crypto.randomUUID()) {
  // A realistic export shape: typed content[] blocks including the MCP tool
  // call and its result carrying the marker token.
  return {
    uuid: externalId,
    name: "agency rant",
    created_at: "2026-07-18T10:00:00Z",
    updated_at: "2026-07-18T11:00:00Z",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "I want more agency, here is my rant…", parent_message_uuid: ROOT, created_at: "2026-07-18T10:00:00Z" },
      { uuid: "m2", sender: "assistant", text: "heard. here's what I'd create…", parent_message_uuid: "m1", created_at: "2026-07-18T10:05:00Z" },
      { uuid: "m3", sender: "human", text: "yes, create it", parent_message_uuid: "m2", created_at: "2026-07-18T10:06:00Z" },
      {
        uuid: "m4",
        sender: "assistant",
        parent_message_uuid: "m3",
        created_at: "2026-07-18T10:07:00Z",
        content: [
          { type: "text", text: "Submitting now." },
          { type: "tool_use", name: "record_create", input: { summary_md: "goal rant digest" } },
          { type: "tool_result", name: "record_create", content: [{ type: "text", text: `{"status":"submitted_for_review","marker_token":"${marker}"}` }] },
          { type: "text", text: `Submitted for review. Marker: ${marker}` },
        ],
      },
    ],
  };
}

function submitAndApply() {
  const cs = createRecordChangeSet({
    summaryMd: "goal rant digest",
    operations: [
      { op: "create", tempId: "goal", model: "organized_goal", role: "central", fields: { title: "higher agency" } },
      { op: "create", tempId: "idea", model: "experiment_idea", role: "satellite", fields: { title: "make a content series" } },
      { op: "link", relation: "idea_goal", from: "temp:idea", to: "temp:goal", description: "reps of being seen" },
    ],
  });
  expect(applyRecordChangeSet(cs.id).ok).toBe(true);
  return cs;
}

describe("provenance stitching", () => {
  test("parser keeps tool_use/tool_result blocks so markers survive", () => {
    const parsed = parseConversation(exportedConversation("rc_aaaaaaaaaaaa"));
    const last = parsed.messages[parsed.messages.length - 1]!;
    expect(last.content).toContain("tool_use: record_create");
    expect(last.content).toContain("rc_aaaaaaaaaaaa");
  });

  test("apply-first, import-second: import stitches links and backfills source conversation", () => {
    const cs = submitAndApply();
    const report = ingestFile([exportedConversation(cs.markerToken!)]);
    expect(report.new).toBe(1);

    const links = db.select().from(conversationRecordLink).all();
    expect(links).toHaveLength(2);
    expect(links.every(l => l.sliceEndIdx === 3)).toBe(true); // marker in message index 3
    expect(links.map(l => l.role).sort()).toEqual(["created_central", "created_satellite"]);

    const goal = db.select().from(organizedGoal).all()[0]!;
    expect(goal.sourceConversationId).toBe(links[0]!.conversationId);

    // read_record surfaces the slice reference
    const detail = readRecord("organized_goal", goal.lineageId!)!;
    expect(detail.conversationSlices).toHaveLength(1);
    expect(detail.conversationSlices[0]!.title).toBe("agency rant");
  });

  test("import-first, apply-second: apply heals the missing links", () => {
    const marker = "rc_beadfeedbead";
    ingestFile([exportedConversation(marker)]);
    expect(db.select().from(conversationRecordLink).all()).toHaveLength(0);

    // craft a change set with that exact marker, then apply it
    const cs = createRecordChangeSet({
      summaryMd: "late apply",
      operations: [{ op: "create", tempId: "g", model: "organized_goal", role: "central", fields: { title: "late goal" } }],
    });
    db.run(`UPDATE draft_change_set SET marker_token = '${marker}' WHERE id = '${cs.id}'`);
    expect(applyRecordChangeSet(cs.id).ok).toBe(true);

    // apply-time stitching is fire-and-forget via dynamic import; give it a tick
    return new Promise<void>(resolve =>
      setTimeout(() => {
        const links = db.select().from(conversationRecordLink).all();
        expect(links).toHaveLength(1);
        expect(links[0]!.role).toBe("created_central");
        resolve();
      }, 50),
    );
  });

  test("re-import is idempotent: links are replaced, not duplicated", () => {
    const cs = submitAndApply();
    const exported = exportedConversation(cs.markerToken!);
    ingestFile([exported]);
    ingestFile([exported]); // unchanged path still stitches
    const links = db
      .select()
      .from(conversationRecordLink)
      .where(eq(conversationRecordLink.markerToken, cs.markerToken!))
      .all();
    expect(links).toHaveLength(2);
  });
});
