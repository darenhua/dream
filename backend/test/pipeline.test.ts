import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { conversation, extraction } from "../src/db/schema";
import { seedConfig } from "../src/services/config";
import {
  addManualExtraction,
  confirmExtractions,
  deleteExtraction,
  FrozenExtractionError,
  listExtractions,
  patchExtraction,
} from "../src/services/extractions";
import { pipelineState } from "../src/services/pipeline";
import { pendingDistills } from "../src/services/distill";
import { pendingDerives } from "../src/services/derive";
import { acceptRant, detectPendingRants, rejectRant } from "../src/services/rantDetection";
import { cancelShaping, finishShaping, startShaping } from "../src/services/shaping";
import { chatMessage } from "../src/db/schema";

function makeConversation(overrides: Partial<typeof conversation.$inferInsert> = {}) {
  return db
    .insert(conversation)
    .values({
      externalId: crypto.randomUUID(),
      title: "a rant",
      rawJson: "{}",
      contentJson: JSON.stringify([{ role: "user", content: "I want to wake at 6am", ts: null }]),
      contentHash: "h1",
      ...overrides,
    })
    .returning()
    .get();
}

function draftExtraction(conversationId: string) {
  return db
    .insert(extraction)
    .values({
      conversationId,
      kind: "goal_talk",
      text: "I want to wake at 6am",
      startIdx: 0,
      endIdx: 0,
      contentHash: "h1",
      origin: "agent",
    })
    .returning()
    .get();
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

describe("conversation pipeline FSM", () => {
  test("intake gate: accepted candidates walk to derived, rejected never distill", () => {
    // Fresh import: not yet detected.
    const fresh = makeConversation();
    expect(pipelineState(fresh)).toBe("pending_detection");
    expect(pendingDistills().map(c => c.id)).not.toContain(fresh.id);

    // Detector verdicts.
    db.update(conversation)
      .set({ rantVerdict: "candidate", rantStatus: "proposed", detectorNote: "digging into mornings" })
      .where(eq(conversation.id, fresh.id))
      .run();
    let row = db.select().from(conversation).where(eq(conversation.id, fresh.id)).get()!;
    expect(pipelineState(row)).toBe("rant_candidate");
    expect(pendingDistills().map(c => c.id)).not.toContain(fresh.id); // proposed ≠ admitted

    const organized = makeConversation({ rantVerdict: "not_candidate", rantDetectedAt: new Date().toISOString() });
    expect(pipelineState(organized)).toBe("idle");

    // Human gate: reject files it away, forever out of the distill queue.
    const dismissed = makeConversation({ rantVerdict: "candidate", rantStatus: "proposed" });
    rejectRant(dismissed.id);
    const dismissedRow = db.select().from(conversation).where(eq(conversation.id, dismissed.id)).get()!;
    expect(pipelineState(dismissedRow)).toBe("rejected");
    expect(pendingDistills().map(c => c.id)).not.toContain(dismissed.id);

    // Human gate: accept admits it.
    acceptRant(fresh.id);
    row = db.select().from(conversation).where(eq(conversation.id, fresh.id)).get()!;
    expect(pipelineState(row)).toBe("awaiting_distill");
    expect(pendingDistills().map(c => c.id)).toContain(fresh.id);

    db.update(conversation)
      .set({ distilledAt: new Date().toISOString() })
      .where(eq(conversation.id, fresh.id))
      .run();
    row = db.select().from(conversation).where(eq(conversation.id, fresh.id)).get()!;
    expect(pipelineState(row)).toBe("awaiting_review");
    expect(pendingDistills().map(c => c.id)).not.toContain(fresh.id);

    draftExtraction(fresh.id);
    confirmExtractions(fresh.id);
    row = db.select().from(conversation).where(eq(conversation.id, fresh.id)).get()!;
    expect(pipelineState(row)).toBe("awaiting_derive");
    expect(pendingDerives().map(c => c.id)).toContain(fresh.id);

    db.update(conversation)
      .set({ derivedAt: new Date().toISOString() })
      .where(eq(conversation.id, fresh.id))
      .run();
    row = db.select().from(conversation).where(eq(conversation.id, fresh.id)).get()!;
    expect(pipelineState(row)).toBe("derived");
    expect(pendingDerives()).toHaveLength(0);
  });

  test("slug rows auto-accept through detection without an LLM call", async () => {
    const slugged = makeConversation({ slugDetected: true, slugMessageIdx: 1 });
    // Only slugged rows pending → the fast path handles all of them, no batches.
    const result = await detectPendingRants("manual");
    expect(result.autoAccepted).toBe(1);
    expect(result.processed).toBe(0); // nothing went to the classifier
    const row = db.select().from(conversation).where(eq(conversation.id, slugged.id)).get()!;
    expect(row.rantStatus).toBe("accepted");
    expect(pipelineState(row)).toBe("awaiting_distill");
    expect(pendingDistills().map(c => c.id)).toContain(slugged.id);
  });

  test("legacy slug-era rows keep their distill-chain state without gate columns", () => {
    const legacy = makeConversation({ slugDetected: true, distilledAt: new Date().toISOString() });
    expect(pipelineState(legacy)).toBe("awaiting_review");
  });

  test("parse_failed conversations never enter the distill queue", () => {
    const broken = makeConversation({ parseError: "broken chain", contentJson: null });
    expect(pipelineState(broken)).toBe("parse_failed");
    expect(pendingDistills()).toHaveLength(0);
  });

  test("finished shaping conversations enter the pipeline pre-accepted", () => {
    const { sessionId } = startShaping();
    // No user turn yet → nothing to keep.
    expect(() => finishShaping(sessionId)).toThrow();

    db.insert(chatMessage)
      .values({ sessionId, role: "user", content: "I want to try phone-free saturday mornings" })
      .run();
    const { conversationId } = finishShaping(sessionId);

    const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get()!;
    expect(convo.source).toBe("in_app");
    expect(convo.rantStatus).toBe("accepted");
    expect(pipelineState(convo)).toBe("awaiting_distill");
    expect(pendingDistills().map(c => c.id)).toContain(conversationId);
    // The transcript carries both sides of the conversation.
    const transcript = JSON.parse(convo.contentJson!) as { role: string; content: string }[];
    expect(transcript.some(m => m.role === "assistant")).toBe(true);
    expect(transcript.some(m => m.content.includes("saturday mornings"))).toBe(true);

    // A finished session can't be finished twice or cancelled.
    expect(() => finishShaping(sessionId)).toThrow();
    expect(cancelShaping(sessionId)).toBe(false);
  });

  test("cancelled shaping sessions leave no conversation behind", () => {
    const before = db.select().from(conversation).all().length;
    const { sessionId } = startShaping();
    expect(cancelShaping(sessionId)).toBe(true);
    expect(db.select().from(conversation).all().length).toBe(before);
  });
});

describe("extraction review gate", () => {
  test("curation works pre-confirm: edit, add, delete", () => {
    const convo = makeConversation({
      slugDetected: true,
      distilledAt: new Date().toISOString(),
    });
    const x = draftExtraction(convo.id);

    const edited = patchExtraction(x.id, { text: "I want my mornings back", kind: "feeling" })!;
    expect(edited.text).toBe("I want my mornings back");
    expect(edited.kind).toBe("feeling");

    const manual = addManualExtraction({
      conversationId: convo.id,
      kind: "habit_talk",
      text: "the agent missed my guitar habit",
    });
    expect(manual.origin).toBe("manual");

    expect(deleteExtraction(x.id)).toBe(true);
    expect(listExtractions({ conversationId: convo.id })).toHaveLength(1);
  });

  test("confirm freezes everything — the review happens exactly once", () => {
    const convo = makeConversation({ slugDetected: true, distilledAt: new Date().toISOString() });
    const x = draftExtraction(convo.id);

    const { confirmed } = confirmExtractions(convo.id);
    expect(confirmed).toBe(1);

    expect(() => patchExtraction(x.id, { text: "rewrite history" })).toThrow(FrozenExtractionError);
    expect(() => deleteExtraction(x.id)).toThrow(FrozenExtractionError);

    const row = db.select().from(conversation).where(eq(conversation.id, convo.id)).get()!;
    expect(row.extractionsReviewedAt).toBeTruthy();
  });

  test("confirm requires distillation first", () => {
    const convo = makeConversation({ slugDetected: true });
    expect(() => confirmExtractions(convo.id)).toThrow(/not been distilled/);
  });

  test("re-distill semantics: old confirmed extractions survive as facts", () => {
    const convo = makeConversation({ slugDetected: true, distilledAt: new Date().toISOString() });
    draftExtraction(convo.id);
    confirmExtractions(convo.id);

    // simulate what redistill() does to the pipeline columns
    db.update(conversation)
      .set({ distilledAt: null, extractionsReviewedAt: null, derivedAt: null })
      .where(eq(conversation.id, convo.id))
      .run();
    // the confirmed extraction is untouched — immutable fact about the rant
    const survivors = listExtractions({ conversationId: convo.id, confirmed: true });
    expect(survivors).toHaveLength(1);
  });
});
