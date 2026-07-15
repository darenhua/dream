import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { outboundMessage, witness } from "../src/db/schema";
import { seedConfig, setConfig } from "../src/services/config";
import { flushOutbound, initMessaging } from "../src/services/messaging/messenger";
import {
  approveOutbound,
  cancelPendingForWitness,
  enqueueOutbound,
  listOutbound,
} from "../src/services/outbox";
import { computeStrikes, registerStrikeAlertSink, runStrikeCheck } from "../src/services/strikes";
import { createInvite, setGoals, setPrimary } from "../src/services/witnesses";
import { conversation, goal } from "../src/db/schema";

// The approval gate: nothing reaches a transport without status=approved, and
// the mock transport turns every delivery into an inspectable event row.

const ASOF = "2026-07-14";

function makeWitness(fields: { name: string; linked?: boolean; primary?: boolean } = { name: "A" }) {
  const w = createInvite({ name: fields.name });
  if (fields.linked) {
    db.update(witness)
      .set({ status: "active", chatId: `chat-${fields.name}` })
      .where(eq(witness.id, w.id))
      .run();
  }
  if (fields.primary) setPrimary(w.id);
  return db.select().from(witness).where(eq(witness.id, w.id)).get()!;
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
  setConfig("WITNESS_QUIET_HOURS", null); // tests run at any hour — no notBefore gates
  registerStrikeAlertSink(null);
});

describe("outbox approval gate", () => {
  test("pending rows never flush; approved rows to linked chats deliver via mock", async () => {
    const w = makeWitness({ name: "A", linked: true });
    const row = enqueueOutbound({ witnessId: w.id, kind: "review_share", bodyText: "hello friend" })!;
    expect(row.status).toBe("pending_approval");

    let flush = await flushOutbound();
    expect(flush.sent).toBe(0); // the gate holds

    approveOutbound(row.id);
    flush = await flushOutbound();
    expect(flush.sent).toBe(1);
    const sent = db.select().from(outboundMessage).where(eq(outboundMessage.id, row.id)).get()!;
    expect(sent.status).toBe("sent");
    expect(sent.transportMessageId).toStartWith("mock-");
  });

  test("approved rows for unlinked witnesses stay approved (manual copy protocol)", async () => {
    const w = makeWitness({ name: "B" }); // invited, no chat
    const row = enqueueOutbound({ witnessId: w.id, kind: "duty_ping", bodyText: "ping" })!;
    approveOutbound(row.id);
    const flush = await flushOutbound();
    expect(flush.skippedUnlinked).toBe(1);
    expect(db.select().from(outboundMessage).where(eq(outboundMessage.id, row.id)).get()!.status).toBe("approved");
  });

  test("dedupeKey: one message per episode", () => {
    const w = makeWitness({ name: "C" });
    expect(enqueueOutbound({ witnessId: w.id, kind: "duty_ping", bodyText: "x", dedupeKey: "ep:1" })).not.toBeNull();
    expect(enqueueOutbound({ witnessId: w.id, kind: "duty_ping", bodyText: "x again", dedupeKey: "ep:1" })).toBeNull();
  });

  test("re-scoping a witness cancels their pending composed messages", () => {
    const g = db.insert(goal).values({ title: "g", status: "active", origin: "manual" }).returning().get();
    const w = makeWitness({ name: "D" });
    enqueueOutbound({ witnessId: w.id, kind: "review_share", bodyText: "composed under old scope" });
    setGoals(w.id, [g.id]);
    expect(listOutbound("pending_approval")).toHaveLength(0);
    expect(cancelPendingForWitness(w.id)).toBe(0); // nothing left
  });

  test("strike alert flows tripwire → outbox (hand-approval) end to end", async () => {
    initMessaging(); // registers the real sink (mock transport)
    setConfig("STRIKE_ALERTS_ENABLED", true);
    makeWitness({ name: "P", linked: true, primary: true });
    // 9 rant-quiet days → 3 strikes ≥ threshold.
    db.insert(conversation)
      .values({
        externalId: crypto.randomUUID(),
        title: "old rant",
        rawJson: "{}",
        contentJson: "[]",
        rantStatus: "accepted",
        rantResolvedAt: new Date(Date.parse(`${ASOF}T12:00:00`) - 9 * 86_400_000).toISOString(),
        distillRequested: true,
        createdAt: new Date(Date.parse(`${ASOF}T12:00:00`) - 9 * 86_400_000).toISOString(),
      })
      .run();

    expect(computeStrikes(ASOF).total).toBe(3);
    const r = await runStrikeCheck(ASOF);
    expect(r.alertFired).toBe(true);
    // Strike alerts skip approval by design (nobody's home to approve) and
    // deliver straight through the mock transport.
    const rows = db.select().from(outboundMessage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("strike_alert");
    expect(rows[0]!.bodyText).toContain("no new rants in 9 days");
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.transportMessageId).toStartWith("mock-");
  });
});
