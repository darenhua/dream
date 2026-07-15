import { eq } from "drizzle-orm";
import { db } from "../../db";
import { witness } from "../../db/schema";
import { WitnessPromptOutput } from "../../domain/schemas";
import { runStructured } from "../agentRunner";
import { getConfig } from "../config";
import { emit } from "../events";
import { enqueueOutbound, markFailed, markSent, sendableOutbound } from "../outbox";
import { registerStrikeAlertSink, type StrikeReport } from "../strikes";
import { newWorkspace } from "../projector";
import { linkedPrimaryWitness, listWitnesses } from "../witnesses";
import { witnessContextMd } from "../witnessScope";
import { createMockTransport } from "./mockTransport";
import type { ChatTransport } from "./transport";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The transport-agnostic orchestrator. Hard invariants live HERE, above any
// wire: the agent never messages the user, strike alerts go only to the
// linked primary, every message is self-contained, and nothing sends without
// an approved outbox row.

let transport: ChatTransport = createMockTransport();
export function activeTransport(): ChatTransport {
  return transport;
}
export function setTransport(t: ChatTransport) {
  transport = t;
}

// Strike sink: the tripwire's delivery path. Returns the witness id alerted
// (consuming the episode) or null → tripwire stays dark.
export function initMessaging() {
  registerStrikeAlertSink(async (body: string, _report: StrikeReport) => {
    const primary = linkedPrimaryWitness();
    if (!primary) return null;
    const row = enqueueOutbound({
      witnessId: primary.id,
      kind: "strike_alert",
      bodyText: body,
      dedupeKey: `strike_alert:${new Date().toISOString().slice(0, 10)}`,
    });
    if (!row) return null;
    await flushOutbound(); // strike alerts don't wait for the next heartbeat
    return primary.id;
  });
}

// Send everything approved and past its notBefore. Rows for witnesses with no
// linked chat stay approved (manual protocol: user copies them by hand).
// TRANSPORT="external": the side-by-side messenger daemon owns delivery — the
// in-process flush must not touch rows or the two wires would double-send.
export async function flushOutbound(): Promise<{
  sent: number;
  skippedUnlinked: number;
  failed: number;
  external?: boolean;
}> {
  if (getConfig<string>("TRANSPORT") === "external") {
    return { sent: 0, skippedUnlinked: 0, failed: 0, external: true };
  }
  const rows = sendableOutbound();
  let sent = 0;
  let skippedUnlinked = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.chatId) {
      skippedUnlinked++;
      continue;
    }
    try {
      const { messageId } = await transport.sendText(row.chatId, row.bodyText);
      markSent(row.id, messageId);
      sent++;
    } catch (e) {
      markFailed(row.id, e instanceof Error ? e.message : String(e));
      failed++;
    }
  }
  return { sent, skippedUnlinked, failed };
}

// Random-interval friend prompts: ALL witnesses, each scoped to their goals,
// bounded by per-witness cadence + global min spacing + mute. Randomness
// defeats habituation; the bounds defeat fatigue.
export async function scheduleWitnessPrompts(trigger: "daily" | "manual") {
  const minHours = getConfig<number>("WITNESS_PROMPT_MIN_HOURS");
  const now = Date.now();
  const results: Record<string, string> = {};

  for (const w of listWitnesses()) {
    if (w.status !== "active" && w.status !== "invited") continue;
    if (w.goalIds.length === 0) {
      results[w.name] = "skipped: no scoped goals";
      continue;
    }
    if (w.mutedUntil && w.mutedUntil > new Date().toISOString()) {
      results[w.name] = "skipped: muted";
      continue;
    }
    if (w.lastPromptAt && now - Date.parse(w.lastPromptAt) < minHours * 3_600_000) {
      results[w.name] = "skipped: min spacing";
      continue;
    }
    const dueDays = w.lastPromptAt
      ? (now - Date.parse(w.lastPromptAt)) / 86_400_000
      : w.promptCadenceDays; // never prompted → eligible immediately
    if (dueDays < w.promptCadenceDays) {
      results[w.name] = "skipped: cadence";
      continue;
    }
    // Random-interval: eligible ≠ prompted. A coin flip per heartbeat keeps
    // the arrival day unpredictable while cadence bounds the average rate.
    if (Math.random() < 0.5) {
      results[w.name] = "skipped: dice";
      continue;
    }

    const dir = newWorkspace("witness_prompter");
    writeFileSync(join(dir, "witness-context.md"), witnessContextMd(w.id));
    const run = await runStructured("witness_prompter", dir, WitnessPromptOutput, { trigger });
    if (run.status !== "ok" || !run.output) {
      results[w.name] = `prompter failed: ${run.error}`;
      continue;
    }
    const row = enqueueOutbound({
      witnessId: w.id,
      kind: "random_prompt",
      bodyText: run.output.body_text,
      dedupeKey: `random_prompt:${w.id}:${new Date().toISOString().slice(0, 10)}`,
    });
    if (row) {
      db.update(witness).set({ lastPromptAt: new Date().toISOString() }).where(eq(witness.id, w.id)).run();
      results[w.name] = "prompt enqueued";
      emit("witness", w.id, "witness_prompt_enqueued", {});
    } else {
      results[w.name] = "deduped";
    }
  }
  return results;
}
