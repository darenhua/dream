import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { experiment, experimentGoal, goal, goalEvidence, witness } from "../src/db/schema";
import { seedConfig, setConfig } from "../src/services/config";
import { handleInbound } from "../src/services/messaging/inbound";

// Inbound routing is social plumbing — a silent failure here means a friend's
// message vanishes or a stranger links themselves to the witness seat.

const CHAT = "any;+;group-abc";
const FRIEND = "+15551234567";
const ME = "+15559990000";

function makeWitness(overrides: Partial<typeof witness.$inferInsert> = {}) {
  return db
    .insert(witness)
    .values({ name: "Alex", handle: FRIEND, inviteCode: "ABCD1234", ...overrides })
    .returning()
    .get();
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
  setConfig("USER_IMESSAGE_HANDLE", ME);
});

describe("inbound routing", () => {
  test("JOIN <code> from an unknown chat links the invited witness", () => {
    const w = makeWitness();
    const result = handleInbound({ chatId: CHAT, senderHandle: FRIEND, text: "join ABCD1234", messageId: "m1" });
    expect(result).toEqual({ action: "linked", witnessId: w.id });
    const row = db.select().from(witness).where(eq(witness.id, w.id)).get()!;
    expect(row.chatId).toBe(CHAT);
    expect(row.status).toBe("active");
  });

  test("a wrong code from a stranger links nothing", () => {
    makeWitness();
    const result = handleInbound({ chatId: "any;-;stranger", senderHandle: "+19998887777", text: "JOIN WRONG99" });
    expect(result.action).toBe("stored");
    expect(db.select().from(witness).all()[0]!.chatId).toBeNull();
  });

  test("an already-linked witness's code cannot be replayed from another chat", () => {
    const w = makeWitness({ chatId: CHAT });
    const result = handleInbound({ chatId: "any;-;other", senderHandle: FRIEND, text: "join ABCD1234" });
    expect(result.action).toBe("stored");
    expect(db.select().from(witness).where(eq(witness.id, w.id)).get()!.chatId).toBe(CHAT);
  });

  test("transportMessageId dedupes redelivery", () => {
    makeWitness({ chatId: CHAT });
    const first = handleInbound({ chatId: CHAT, senderHandle: FRIEND, text: "mute 1w", messageId: "dup" });
    const second = handleInbound({ chatId: CHAT, senderHandle: FRIEND, text: "mute 1w", messageId: "dup" });
    expect(first.action).toBe("muted");
    expect(second.action).toBe("deduped");
  });

  test("friend commands: mute Nw / less / more tune the seat", () => {
    const w = makeWitness({ chatId: CHAT });
    handleInbound({ chatId: CHAT, senderHandle: FRIEND, text: "mute 2w" });
    let row = db.select().from(witness).where(eq(witness.id, w.id)).get()!;
    expect(row.mutedUntil).not.toBeNull();
    expect(Date.parse(row.mutedUntil!)).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    handleInbound({ chatId: CHAT, senderHandle: FRIEND, text: "less" });
    row = db.select().from(witness).where(eq(witness.id, w.id)).get()!;
    expect(row.promptCadenceDays).toBe(7); // 4 + 3

    handleInbound({ chatId: CHAT, senderHandle: FRIEND, text: "more" });
    row = db.select().from(witness).where(eq(witness.id, w.id)).get()!;
    expect(row.promptCadenceDays).toBe(5); // 7 - 2
  });

  test("the user's own substantive reply becomes evidence on the running experiment's goals", () => {
    const w = makeWitness({ chatId: CHAT });
    const g = db.insert(goal).values({ title: "ship music", status: "active", origin: "manual" }).returning().get();
    const e = db
      .insert(experiment)
      .values({ title: "studio saturdays", kind: "actionable", status: "running" })
      .returning()
      .get();
    db.insert(experimentGoal).values({ experimentId: e.id, goalId: g.id }).run();

    const result = handleInbound({
      chatId: CHAT,
      senderHandle: ME,
      text: "honestly the saturday session slipped because I stayed up friday — the phone was back at my bed",
    });
    expect(result).toEqual({ action: "evidence", witnessId: w.id });
    const ev = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.note).toContain("said to Alex");
    expect(ev[0]!.note).toContain("stayed up friday");
  });

  test("the user's short acks are stored, not evidence; friend chatter is stored, never evidence", () => {
    makeWitness({ chatId: CHAT });
    const g = db.insert(goal).values({ title: "ship music", status: "active", origin: "manual" }).returning().get();
    const e = db.insert(experiment).values({ title: "x", kind: "actionable", status: "running" }).returning().get();
    db.insert(experimentGoal).values({ experimentId: e.id, goalId: g.id }).run();

    expect(handleInbound({ chatId: CHAT, senderHandle: ME, text: "ha yeah" }).action).toBe("stored");
    expect(
      handleInbound({ chatId: CHAT, senderHandle: FRIEND, text: "so how did the studio thing actually go??" })
        .action,
    ).toBe("stored");
    expect(db.select().from(goalEvidence).all()).toHaveLength(0);
  });

  test("a raw candidate cannot become the witness chat's active evidence sink", () => {
    const w = makeWitness({ chatId: CHAT });
    const g = db.insert(goal).values({ title: "ship music", status: "active", origin: "manual" }).returning().get();
    const candidate = db
      .insert(experiment)
      .values({ title: "uncommitted raw idea", kind: "candidate", status: "running" })
      .returning()
      .get();
    db.insert(experimentGoal).values({ experimentId: candidate.id, goalId: g.id }).run();

    const result = handleInbound({
      chatId: CHAT,
      senderHandle: ME,
      text: "this is a long enough update but should not be attached to raw candidate work",
    });
    expect(result).toEqual({ action: "stored", witnessId: w.id });
    expect(db.select().from(goalEvidence).all()).toHaveLength(0);
  });
});
