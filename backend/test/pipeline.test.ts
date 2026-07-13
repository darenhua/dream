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
  test("state predicates walk imported → derived", () => {
    const idle = makeConversation();
    expect(pipelineState(idle)).toBe("idle");
    expect(pendingDistills().map(c => c.id)).not.toContain(idle.id);

    const slugged = makeConversation({ slugDetected: true, slugMessageIdx: 1 });
    expect(pipelineState(slugged)).toBe("awaiting_distill");
    expect(pendingDistills().map(c => c.id)).toContain(slugged.id);

    // manual add: distill_requested puts an un-slugged convo in the queue
    db.update(conversation).set({ distillRequested: true }).where(eq(conversation.id, idle.id)).run();
    expect(pendingDistills().map(c => c.id)).toContain(idle.id);

    db.update(conversation)
      .set({ distilledAt: new Date().toISOString() })
      .where(eq(conversation.id, slugged.id))
      .run();
    let row = db.select().from(conversation).where(eq(conversation.id, slugged.id)).get()!;
    expect(pipelineState(row)).toBe("awaiting_review");
    expect(pendingDistills().map(c => c.id)).not.toContain(slugged.id);

    draftExtraction(slugged.id);
    confirmExtractions(slugged.id);
    row = db.select().from(conversation).where(eq(conversation.id, slugged.id)).get()!;
    expect(pipelineState(row)).toBe("awaiting_derive");
    expect(pendingDerives().map(c => c.id)).toContain(slugged.id);

    db.update(conversation)
      .set({ derivedAt: new Date().toISOString() })
      .where(eq(conversation.id, slugged.id))
      .run();
    row = db.select().from(conversation).where(eq(conversation.id, slugged.id)).get()!;
    expect(pipelineState(row)).toBe("derived");
    expect(pendingDerives()).toHaveLength(0);
  });

  test("parse_failed conversations never enter the distill queue", () => {
    const broken = makeConversation({ slugDetected: true, parseError: "broken chain", contentJson: null });
    expect(pipelineState(broken)).toBe("parse_failed");
    expect(pendingDistills()).toHaveLength(0);
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
