import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { category, goal, goalEvidence, proposal, registryItem } from "../db/schema";
import type { CategorizerOutputT, DeriverProposalT } from "../domain/schemas";
import { emit } from "./events";
import { createGoal, setGoalStatus } from "./goals";
import { createLink } from "./rantLinks";

type ProposalKind = typeof proposal.$inferSelect.kind;

// Categorization payload: ONE proposal per conversation bundling the agent's
// categorizations + registry catches (matches the dashboard's one-row filing UI).
export interface CategorizationPayload extends CategorizerOutputT {
  conversation_id: string;
  source_conversation_ids: string[];
}

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

// §7.10 — the entire "no queue debt" mechanic: one UPDATE before each derive.
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

export function listProposals(opts: { status?: string; limit?: number }) {
  return db
    .select()
    .from(proposal)
    .where(
      opts.status ? eq(proposal.status, opts.status as typeof proposal.$inferSelect.status) : undefined,
    )
    .orderBy(desc(proposal.createdAt))
    .limit(opts.limit ?? 100)
    .all()
    .map(p => ({ ...p, payload: JSON.parse(p.payloadJson) }));
}

function addEvidence(goalId: string, conversationIds: string[] | undefined, note: string | null) {
  for (const conversationId of conversationIds ?? []) {
    db.insert(goalEvidence).values({ goalId, conversationId, note }).run();
  }
  if (!conversationIds?.length && note) {
    db.insert(goalEvidence).values({ goalId, note }).run();
  }
}

// §8.8 — the apply-switch: transactional apply per kind + events. Agents never
// mutate ratified state; this function, on human approval, is the only door.
export function approveProposal(id: string): { ok: boolean; notes: string[]; error?: string } {
  const row = db.select().from(proposal).where(eq(proposal.id, id)).get();
  if (!row) return { ok: false, notes: [], error: "proposal not found" };
  if (row.status !== "pending") {
    return { ok: false, notes: [], error: `proposal is ${row.status}, not pending` };
  }

  const notes: string[] = [];
  try {
    db.transaction(() => {
      applyProposal(row.kind, JSON.parse(row.payloadJson), row.scopeKey, notes);
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

function applyProposal(kind: ProposalKind, payload: any, scopeKey: string, notes: string[]) {
  const scopeCategoryId = scopeKey.startsWith("category:") ? scopeKey.slice("category:".length) : null;

  switch (kind) {
    case "categorization": {
      const p = payload as CategorizationPayload;
      for (const cat of p.categorizations) {
        let categoryId = cat.category_id ?? null;
        if (!categoryId && cat.new_category) {
          // Amendment 7 — approving a new-category suggestion creates it first.
          const existing = db
            .select()
            .from(category)
            .where(eq(category.name, cat.new_category.name))
            .get();
          categoryId = existing
            ? existing.id
            : db
                .insert(category)
                .values({ name: cat.new_category.name, description: cat.new_category.description })
                .returning({ id: category.id })
                .get().id;
          if (!existing) notes.push(`created category "${cat.new_category.name}"`);
        }
        if (!categoryId) continue;
        createLink(p.conversation_id, categoryId, "agent");
      }
      for (const add of p.registry_adds) {
        db.insert(registryItem)
          .values({
            kind: add.kind,
            title: add.title,
            note: add.note ?? null,
            valence: add.kind === "habit" ? (add.valence ?? null) : null,
            status: "active",
            sourceConversationId: p.conversation_id,
          })
          .run();
      }
      break;
    }

    case "goal_create": {
      const p = payload as Extract<DeriverProposalT, { kind: "goal_create" }>;
      const { goal: created, note } = createGoal({
        categoryId: scopeCategoryId,
        title: p.title,
        identityClause: p.identity_clause,
        synthesisMd: p.synthesis_md,
        status: "active", // budget rule may demote to backlog
        origin: "derived",
      });
      if (note) notes.push(note);
      addEvidence(created.id, p.source_conversation_ids, null);
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
      addEvidence(p.goal_id, p.source_conversation_ids, p.reason ?? null);
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
      addEvidence(p.goal_id, p.source_conversation_ids, p.reason ?? null);
      break;
    }

    case "goal_status": {
      const p = payload as Extract<DeriverProposalT, { kind: "goal_status" }>;
      const result = setGoalStatus(p.goal_id, p.status);
      if (!result) throw new Error(`goal ${p.goal_id} not found`);
      if (result.note) notes.push(result.note);
      addEvidence(p.goal_id, p.source_conversation_ids, p.reason ?? null);
      break;
    }

    case "registry_add": {
      const p = payload as Extract<DeriverProposalT, { kind: "registry_add" }>;
      db.insert(registryItem)
        .values({
          kind: p.registry_kind,
          title: p.title,
          note: p.note ?? null,
          valence: p.registry_kind === "habit" ? (p.valence ?? null) : null,
          status: "active",
          sourceConversationId: p.source_conversation_ids?.[0] ?? null,
        })
        .run();
      break;
    }

    case "registry_prune": {
      const p = payload as Extract<DeriverProposalT, { kind: "registry_prune" }>;
      const item = db.select().from(registryItem).where(eq(registryItem.id, p.registry_item_id)).get();
      if (!item) throw new Error(`registry item ${p.registry_item_id} not found`);
      if (item.kind === "experience") throw new Error("experiences are append-only (§7.6)");
      db.update(registryItem)
        .set({ status: "removed" })
        .where(eq(registryItem.id, p.registry_item_id))
        .run();
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

  // A denial reason on a goal-scoped proposal is itself evidence (§7.5).
  const payload = JSON.parse(row.payloadJson);
  if (note && payload.goal_id) {
    db.insert(goalEvidence).values({ goalId: payload.goal_id, note: `denied: ${note}` }).run();
  }
  emit("proposal", id, "proposal_denied", { note });
  return { ok: true };
}
