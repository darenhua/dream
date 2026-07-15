import { beforeEach, describe, expect, test } from "bun:test";
import { db, wipeAllTables } from "../src/db";
import { chatMessage, conversation, goal, proposal } from "../src/db/schema";
import { seedConfig } from "../src/services/config";
import { cancelSteer, startSteer, steerContextMd } from "../src/services/steering";

// Guard tests only — the redo finishers run real inference and are verified
// live; what must never regress silently are the membrane guards and the
// context contract (original instructions + inputs + output all present).

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

function distilledConversation() {
  return db
    .insert(conversation)
    .values({
      externalId: crypto.randomUUID(),
      title: "a rant",
      rawJson: "{}",
      contentJson: JSON.stringify([{ role: "user", content: "late night infra rabbit hole again", ts: null }]),
      contentHash: "h",
      rantStatus: "accepted",
      distillRequested: true,
      distilledAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

describe("steer sessions", () => {
  test("distill: requires a distilled conversation, context carries instructions+input+output markers", () => {
    const raw = db
      .insert(conversation)
      .values({ externalId: crypto.randomUUID(), title: "x", rawJson: "{}", contentJson: "[]", contentHash: "h" })
      .returning()
      .get();
    expect(() => startSteer("distill", raw.id)).toThrow(); // not distilled yet

    const convo = distilledConversation();
    const { sessionId } = startSteer("distill", convo.id);
    const session = db.select().from(db._.fullSchema.chatSession).all().find(s => s.id === sessionId)!;
    const ctx = steerContextMd(session);
    expect(ctx).toContain("original instructions");
    expect(ctx).toContain("late night infra rabbit hole"); // the input transcript
    expect(ctx).toContain("What it currently produced"); // the previous output section
  });

  test("proposal: only pending proposals steer", () => {
    const approved = db
      .insert(proposal)
      .values({
        kind: "goal_create",
        payloadJson: JSON.stringify({ title: "x", extraction_ids: [] }),
        scopeKey: "conversation:x",
        status: "approved",
      })
      .returning()
      .get();
    expect(() => startSteer("proposal", approved.id)).toThrow();
  });

  test("unknown targets and cancel semantics", () => {
    expect(() => startSteer("goal", "nope")).toThrow();
    const g = db.insert(goal).values({ title: "g", origin: "manual" }).returning().get();
    const { sessionId } = startSteer("goal", g.id);
    expect(cancelSteer(sessionId)).toBe(true);
    expect(cancelSteer(sessionId)).toBe(false); // already cancelled
  });

  test("a steer session opens with a seeded opener message", () => {
    const convo = distilledConversation();
    const { sessionId, opener } = startSteer("distill", convo.id);
    const messages = db.select().from(chatMessage).all().filter(m => m.sessionId === sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[0]!.content).toBe(opener);
  });
});
