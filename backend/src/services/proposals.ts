import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { conversation, extraction, extractionLink, goal, goalEvidence, proposal } from "../db/schema";
import type { DeriverProposalT } from "../domain/schemas";
import { createEnvironmentItem, patchEnvironmentItem } from "./environment";
import { emit } from "./events";
import { createExperience } from "./experiences";
import { enqueueExperiment } from "./experiments";
import { createGoal } from "./goals";
import { createHabit, patchHabit } from "./habits";

type ProposalKind = typeof proposal.$inferSelect.kind;
type EntityType = "goal" | "habit" | "environment_item" | "experience" | "experiment" | "experiment_task";

export function createProposal(
  kind: ProposalKind,
  payload: unknown,
  scopeKey: string,
  agentRunId: string | null,
) {
  const row = db
    .insert(proposal)
    .values({ kind, payloadJson: JSON.stringify(payload), scopeKey, agentRunId })
    .returning()
    .get();
  emit("proposal", row.id, "proposal_created", { kind, scopeKey });
  return row;
}

// Survives only for manual re-derive of a conversation: its still-pending
// proposals are replaced by the fresh run's view.
export function supersedePending(scopeKey: string): number {
  const rows = db
    .update(proposal)
    .set({ status: "superseded", resolvedAt: new Date().toISOString() })
    .where(and(eq(proposal.scopeKey, scopeKey), eq(proposal.status, "pending")))
    .returning({ id: proposal.id })
    .all();
  for (const r of rows) emit("proposal", r.id, "proposal_superseded", { scopeKey });
  return rows.length;
}

// Cited extractions joined to their conversations — the modal's rant-source
// list comes straight from this shape.
export type CitedExtraction = typeof extraction.$inferSelect & {
  conversationTitle: string | null;
  conversationDate: string | null;
};

function hydrateCitations(
  rows: (typeof proposal.$inferSelect & { payload: Record<string, unknown> })[],
) {
  const citedIds = [...new Set(rows.flatMap(p => (p.payload.extraction_ids as string[] | undefined) ?? []))];
  const cited = citedIds.length
    ? db
        .select({ x: extraction, conversationTitle: conversation.title, conversationDate: conversation.sourceUpdatedAt })
        .from(extraction)
        .innerJoin(conversation, eq(extraction.conversationId, conversation.id))
        .where(inArray(extraction.id, citedIds))
        .all()
    : [];
  const byId = new Map<string, CitedExtraction>(
    cited.map(r => [r.x.id, { ...r.x, conversationTitle: r.conversationTitle, conversationDate: r.conversationDate }]),
  );
  return rows.map(p => ({
    ...p,
    citedExtractions: ((p.payload.extraction_ids as string[] | undefined) ?? [])
      .map(id => byId.get(id))
      .filter((x): x is CitedExtraction => Boolean(x)),
  }));
}

export function listProposals(opts: { status?: string; limit?: number }) {
  const rows = db
    .select()
    .from(proposal)
    .where(
      opts.status ? eq(proposal.status, opts.status as typeof proposal.$inferSelect.status) : undefined,
    )
    .orderBy(desc(proposal.createdAt))
    .limit(opts.limit ?? 100)
    .all()
    .map(p => ({ ...p, payload: JSON.parse(p.payloadJson) as Record<string, unknown> }));
  return hydrateCitations(rows);
}

export function getProposal(id: string) {
  const row = db.select().from(proposal).where(eq(proposal.id, id)).get();
  if (!row) return null;
  return hydrateCitations([{ ...row, payload: JSON.parse(row.payloadJson) }])[0]!;
}

// Permanent provenance: the receipts trail from every ratified entity back
// through extractions to the conversations that birthed it.
function writeProvenance(
  extractionIds: string[] | undefined,
  entityType: EntityType,
  entityId: string,
  proposalId: string,
) {
  for (const extractionId of extractionIds ?? []) {
    db.insert(extractionLink)
      .values({ extractionId, entityType, entityId, proposalId })
      .onConflictDoNothing()
      .run();
  }
}

// Goal evidence keeps working alongside: extraction provenance is the precise
// grounding, goal_evidence carries free-text notes (denials, outcomes).
function addGoalEvidence(goalId: string, note: string | null) {
  if (note) db.insert(goalEvidence).values({ goalId, note }).run();
}

// The apply-switch: the single door through which agent output becomes
// ratified state, on human approval, transactionally.
export function approveProposal(id: string): { ok: boolean; notes: string[]; error?: string } {
  const row = db.select().from(proposal).where(eq(proposal.id, id)).get();
  if (!row) return { ok: false, notes: [], error: "proposal not found" };
  if (row.status !== "pending") {
    return { ok: false, notes: [], error: `proposal is ${row.status}, not pending` };
  }

  const notes: string[] = [];
  try {
    db.transaction(() => {
      applyProposal(row.kind, JSON.parse(row.payloadJson), row.id, notes);
      db.update(proposal)
        .set({ status: "approved", resolvedAt: new Date().toISOString() })
        .where(eq(proposal.id, id))
        .run();
    });
  } catch (e) {
    return { ok: false, notes, error: e instanceof Error ? e.message : String(e) };
  }
  emit("proposal", id, "proposal_approved", { kind: row.kind, notes });
  return { ok: true, notes };
}

function applyProposal(kind: ProposalKind, payload: any, proposalId: string, notes: string[]) {
  switch (kind) {
    case "goal_create": {
      const p = payload as Extract<DeriverProposalT, { kind: "goal_create" }>;
      const { goal: created, note } = createGoal({
        title: p.title,
        identityClause: p.identity_clause,
        synthesisMd: p.synthesis_md,
        status: "active", // budget rule may demote to backlog
        origin: "derived",
      });
      if (note) notes.push(note);
      writeProvenance(p.extraction_ids, "goal", created.id, proposalId);
      break;
    }

    case "goal_update": {
      const p = payload as Extract<DeriverProposalT, { kind: "goal_update" }>;
      const patch: Record<string, string> = {};
      if (p.title) patch.title = p.title;
      if (p.identity_clause) patch.identityClause = p.identity_clause;
      if (p.synthesis_md) patch.synthesisMd = p.synthesis_md;
      const updated = db.update(goal).set(patch).where(eq(goal.id, p.goal_id)).returning().get();
      if (!updated) throw new Error(`goal ${p.goal_id} not found`);
      writeProvenance(p.extraction_ids, "goal", p.goal_id, proposalId);
      addGoalEvidence(p.goal_id, p.reason ?? null);
      break;
    }

    case "synthesis_update": {
      const p = payload as Extract<DeriverProposalT, { kind: "synthesis_update" }>;
      const updated = db
        .update(goal)
        .set({ synthesisMd: p.synthesis_md })
        .where(eq(goal.id, p.goal_id))
        .returning()
        .get();
      if (!updated) throw new Error(`goal ${p.goal_id} not found`);
      writeProvenance(p.extraction_ids, "goal", p.goal_id, proposalId);
      addGoalEvidence(p.goal_id, p.reason ?? null);
      break;
    }

    case "habit_add": {
      const p = payload as Extract<DeriverProposalT, { kind: "habit_add" }>;
      // Derive maps the current self: an approved habit_add is a habit the
      // user already has. Habits-to-build are born inside experiments only.
      const created = createHabit({
        title: p.title,
        note: p.note ?? null,
        valence: p.valence,
        status: "established",
        origin: "derived",
        goalIds: p.goal_ids,
      });
      writeProvenance(p.extraction_ids, "habit", created.id, proposalId);
      break;
    }

    case "habit_update": {
      const p = payload as Extract<DeriverProposalT, { kind: "habit_update" }>;
      const patch: Record<string, string> = {};
      if (p.title) patch.title = p.title;
      if (p.note) patch.note = p.note;
      if (p.valence) patch.valence = p.valence;
      if (p.status) patch.status = p.status;
      const updated = patchHabit(p.habit_id, patch);
      if (!updated) throw new Error(`habit ${p.habit_id} not found`);
      writeProvenance(p.extraction_ids, "habit", p.habit_id, proposalId);
      break;
    }

    case "environment_add": {
      const p = payload as Extract<DeriverProposalT, { kind: "environment_add" }>;
      const created = createEnvironmentItem({
        title: p.title,
        subKind: p.sub_kind,
        note: p.note ?? null,
        origin: "derived",
        goalIds: p.goal_ids,
      });
      writeProvenance(p.extraction_ids, "environment_item", created.id, proposalId);
      break;
    }

    case "environment_update": {
      const p = payload as Extract<DeriverProposalT, { kind: "environment_update" }>;
      const patch: Record<string, string> = {};
      if (p.title) patch.title = p.title;
      if (p.note) patch.note = p.note;
      if (p.sub_kind) patch.subKind = p.sub_kind;
      const updated = patchEnvironmentItem(p.environment_item_id, patch);
      if (!updated) throw new Error(`environment item ${p.environment_item_id} not found`);
      writeProvenance(p.extraction_ids, "environment_item", p.environment_item_id, proposalId);
      break;
    }

    case "experience_add": {
      const p = payload as Extract<DeriverProposalT, { kind: "experience_add" }>;
      const created = createExperience({
        title: p.title,
        note: p.note ?? null,
        state: p.state,
        origin: "derived",
      });
      writeProvenance(p.extraction_ids, "experience", created.id, proposalId);
      break;
    }

    case "experiment_propose": {
      const p = payload as Extract<DeriverProposalT, { kind: "experiment_propose" }>;
      const created = enqueueExperiment({
        title: p.title,
        hypothesisMd: p.hypothesis_md,
        goalIds: p.goal_ids,
        proposalId,
      });
      writeProvenance(p.extraction_ids, "experiment", created.id, proposalId);
      break;
    }

    default:
      throw new Error(`unknown proposal kind: ${kind}`);
  }
}

export function denyProposal(id: string, note?: string): { ok: boolean; error?: string } {
  const row = db.select().from(proposal).where(eq(proposal.id, id)).get();
  if (!row) return { ok: false, error: "proposal not found" };
  if (row.status !== "pending") return { ok: false, error: `proposal is ${row.status}, not pending` };

  db.update(proposal)
    .set({ status: "denied", resolvedAt: new Date().toISOString(), denialNote: note ?? null })
    .where(eq(proposal.id, id))
    .run();

  // A denial reason on a goal-scoped proposal is itself evidence.
  const payload = JSON.parse(row.payloadJson);
  if (note && payload.goal_id) {
    db.insert(goalEvidence).values({ goalId: payload.goal_id, note: `denied: ${note}` }).run();
  }
  emit("proposal", id, "proposal_denied", { note });
  return { ok: true };
}
