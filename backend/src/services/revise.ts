import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { conversation, extraction, proposal } from "../db/schema";
import { ReviserOutput, type ReviserOutputT } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { emit } from "./events";
import { newWorkspace, projectRevision } from "./projector";

// Agent-assisted re-grounding of ONE pending proposal: the user points at a
// rant ("this was also referenced here") and the agent revises the proposal to
// draw on that rant's confirmed extractions. Same kind, same row, still
// pending — approval stays with the human.

export function revisionGuard(
  proposalId: string,
  conversationId: string,
): { ok: true; row: typeof proposal.$inferSelect } | { ok: false; error: string } {
  const row = db.select().from(proposal).where(eq(proposal.id, proposalId)).get();
  if (!row) return { ok: false, error: "proposal not found" };
  if (row.status !== "pending") return { ok: false, error: `proposal is ${row.status}, not pending` };
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) return { ok: false, error: "conversation not found" };
  const confirmed = db
    .select({ id: extraction.id })
    .from(extraction)
    .where(and(eq(extraction.conversationId, conversationId), isNotNull(extraction.confirmedAt)))
    .all();
  if (!confirmed.length) {
    return {
      ok: false,
      error: "that rant has no confirmed extractions yet — do its read-back first",
    };
  }
  return { ok: true, row };
}

// The validate-and-update half, factored agent-free for tests.
export function applyRevision(
  row: typeof proposal.$inferSelect,
  output: ReviserOutputT,
): { ok: true } | { ok: false; error: string } {
  if (output.proposal.kind !== row.kind) {
    return { ok: false, error: `reviser changed the kind (${row.kind} → ${output.proposal.kind})` };
  }
  const citedIds = output.proposal.extraction_ids;
  const known = new Set(
    citedIds.length
      ? db
          .select({ id: extraction.id })
          .from(extraction)
          .where(and(inArray(extraction.id, citedIds), isNotNull(extraction.confirmedAt)))
          .all()
          .map(r => r.id)
      : [],
  );
  if (!citedIds.length || !citedIds.every(id => known.has(id))) {
    return { ok: false, error: "revised proposal cites unknown or unconfirmed extractions" };
  }
  db.update(proposal)
    .set({ payloadJson: JSON.stringify(output.proposal) })
    .where(eq(proposal.id, row.id))
    .run();
  emit("proposal", row.id, "proposal_revised", { kind: row.kind });
  return { ok: true };
}

export async function reviseProposal(
  proposalId: string,
  conversationId: string,
  instruction?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = revisionGuard(proposalId, conversationId);
  if (!guard.ok) return guard;

  const dir = newWorkspace("proposal_reviser");
  projectRevision(guard.row, conversationId, instruction, dir);
  const run = await runStructured("proposal_reviser", dir, ReviserOutput, { trigger: "manual" });
  if (run.status !== "ok" || !run.output) {
    emit("proposal", proposalId, "revision_failed", { agentRunId: run.runId, error: run.error });
    return { ok: false, error: run.error ?? "revision failed" };
  }
  const applied = applyRevision(guard.row, run.output);
  if (!applied.ok) emit("proposal", proposalId, "revision_rejected", { reason: applied.error });
  return applied;
}
