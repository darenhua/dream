import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import {
  category,
  conversation,
  goal,
  goalEvidence,
  rantLink,
  registryItem,
} from "../src/db/schema";
import { seedConfig, setConfig } from "../src/services/config";
import {
  approveProposal,
  createProposal,
  denyProposal,
  listProposals,
  supersedePending,
} from "../src/services/proposals";

function makeConversation(title = "a rant") {
  return db
    .insert(conversation)
    .values({ externalId: crypto.randomUUID(), title, rawJson: "{}", contentJson: "[]" })
    .returning()
    .get();
}

function makeCategory(name: string) {
  return db.insert(category).values({ name }).returning().get();
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

describe("apply-switch per kind", () => {
  test("categorization → rant_link + bundled registry adds; new_category created on approval", () => {
    const convo = makeConversation();
    const existing = makeCategory("dream-coach");
    const p = createProposal(
      "categorization",
      {
        conversation_id: convo.id,
        source_conversation_ids: [convo.id],
        categorizations: [
          { category_id: existing.id, justification: "clearly self-transformation" },
          { new_category: { name: "dream-romantic", description: "romance" }, justification: "also this" },
        ],
        registry_adds: [{ kind: "habit", title: "doomscrolling", valence: "bad" }],
      },
      `conversation:${convo.id}`,
      null,
    );

    const result = approveProposal(p.id);
    expect(result.ok).toBe(true);
    expect(result.notes).toContain('created category "dream-romantic"');

    const links = db.select().from(rantLink).where(eq(rantLink.conversationId, convo.id)).all();
    expect(links).toHaveLength(2);
    expect(links.every(l => l.activeForDerive && l.source === "agent")).toBe(true);

    const items = db.select().from(registryItem).all();
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("habit");
    expect(items[0]!.valence).toBe("bad");
    expect(items[0]!.sourceConversationId).toBe(convo.id);
  });

  test("goal_create → active goal + evidence links", () => {
    const convo = makeConversation();
    const cat = makeCategory("dream-coach");
    const p = createProposal(
      "goal_create",
      {
        kind: "goal_create",
        title: "Fix forward head posture",
        identity_clause: "I am becoming someone who carries himself upright",
        synthesis_md: "posture rants converge",
        source_conversation_ids: [convo.id],
      },
      `category:${cat.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);

    const g = db.select().from(goal).get()!;
    expect(g.status).toBe("active");
    expect(g.categoryId).toBe(cat.id);
    expect(g.origin).toBe("derived");
    expect(g.sortOrder).toBe(1);

    const ev = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.conversationId).toBe(convo.id);
  });

  test("goal_create overflow lands in backlog and says so (budget rule)", () => {
    setConfig("MAX_ACTIVE_GOALS", 1);
    const cat = makeCategory("c");
    const first = createProposal(
      "goal_create",
      { kind: "goal_create", title: "g1", identity_clause: "x", synthesis_md: "", source_conversation_ids: [] },
      `category:${cat.id}`,
      null,
    );
    expect(approveProposal(first.id).notes).toHaveLength(0);

    const second = createProposal(
      "goal_create",
      { kind: "goal_create", title: "g2", identity_clause: "y", synthesis_md: "", source_conversation_ids: [] },
      `category:${cat.id}`,
      null,
    );
    const result = approveProposal(second.id);
    expect(result.ok).toBe(true);
    expect(result.notes[0]).toContain("backlog");

    const g2 = db.select().from(goal).where(eq(goal.title, "g2")).get()!;
    expect(g2.status).toBe("backlog");
  });

  test("goal_update / synthesis_update rewrite fields and record evidence", () => {
    const cat = makeCategory("c");
    const g = db
      .insert(goal)
      .values({ categoryId: cat.id, title: "old", origin: "derived", status: "active" })
      .returning()
      .get();

    const upd = createProposal(
      "goal_update",
      {
        kind: "goal_update",
        goal_id: g.id,
        title: "new title",
        identity_clause: "I am becoming someone new",
        reason: "merged two threads",
        source_conversation_ids: [],
      },
      `category:${cat.id}`,
      null,
    );
    expect(approveProposal(upd.id).ok).toBe(true);
    let fresh = db.select().from(goal).where(eq(goal.id, g.id)).get()!;
    expect(fresh.title).toBe("new title");

    const syn = createProposal(
      "synthesis_update",
      {
        kind: "synthesis_update",
        goal_id: g.id,
        synthesis_md: "rewritten synthesis",
        reason: "new evidence",
        source_conversation_ids: [],
      },
      `category:${cat.id}`,
      null,
    );
    expect(approveProposal(syn.id).ok).toBe(true);
    fresh = db.select().from(goal).where(eq(goal.id, g.id)).get()!;
    expect(fresh.synthesisMd).toBe("rewritten synthesis");

    const ev = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(ev.length).toBeGreaterThanOrEqual(2);
  });

  test("goal_status to active respects the cap (amendment 4)", () => {
    setConfig("MAX_ACTIVE_GOALS", 1);
    const cat = makeCategory("c");
    db.insert(goal).values({ title: "occupies the slot", origin: "manual", status: "active" }).run();
    const dormant = db
      .insert(goal)
      .values({ title: "wants in", origin: "derived", status: "dormant" })
      .returning()
      .get();

    const p = createProposal(
      "goal_status",
      { kind: "goal_status", goal_id: dormant.id, status: "active", reason: "re-emerged", source_conversation_ids: [] },
      `category:${cat.id}`,
      null,
    );
    const result = approveProposal(p.id);
    expect(result.ok).toBe(true);
    expect(result.notes[0]).toContain("backlog");
    expect(db.select().from(goal).where(eq(goal.id, dormant.id)).get()!.status).toBe("backlog");
  });

  test("registry_add + registry_prune; experiences are append-only", () => {
    const cat = makeCategory("c");
    const add = createProposal(
      "registry_add",
      { kind: "registry_add", registry_kind: "environment", title: "messy room", source_conversation_ids: [] },
      `category:${cat.id}`,
      null,
    );
    expect(approveProposal(add.id).ok).toBe(true);
    const item = db.select().from(registryItem).get()!;
    expect(item.status).toBe("active");

    const prune = createProposal(
      "registry_prune",
      { kind: "registry_prune", registry_item_id: item.id, reason: "cleaned it", source_conversation_ids: [] },
      `category:${cat.id}`,
      null,
    );
    expect(approveProposal(prune.id).ok).toBe(true);
    expect(db.select().from(registryItem).get()!.status).toBe("removed");

    const exp = db
      .insert(registryItem)
      .values({ kind: "experience", title: "first open mic", status: "active" })
      .returning()
      .get();
    const badPrune = createProposal(
      "registry_prune",
      { kind: "registry_prune", registry_item_id: exp.id, reason: "nope", source_conversation_ids: [] },
      `category:${cat.id}`,
      null,
    );
    const result = approveProposal(badPrune.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("append-only");
    // failed apply leaves the proposal pending
    expect(listProposals({ status: "pending" })).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("derive supersedes still-pending proposals in its scope only (§7.10)", () => {
    const cat = makeCategory("c");
    const convo = makeConversation();
    const inScope = createProposal("goal_create", { kind: "goal_create", title: "x", identity_clause: "", synthesis_md: "", source_conversation_ids: [] }, `category:${cat.id}`, null);
    const otherScope = createProposal(
      "categorization",
      { conversation_id: convo.id, source_conversation_ids: [convo.id], categorizations: [], registry_adds: [] },
      `conversation:${convo.id}`,
      null,
    );

    expect(supersedePending(`category:${cat.id}`)).toBe(1);
    const all = listProposals({});
    expect(all.find(p => p.id === inScope.id)!.status).toBe("superseded");
    expect(all.find(p => p.id === otherScope.id)!.status).toBe("pending");
  });

  test("deny stores the note and cannot re-resolve", () => {
    const cat = makeCategory("c");
    const g = db.insert(goal).values({ title: "g", origin: "derived", status: "active" }).returning().get();
    const p = createProposal(
      "goal_status",
      { kind: "goal_status", goal_id: g.id, status: "retired", reason: "", source_conversation_ids: [] },
      `category:${cat.id}`,
      null,
    );
    expect(denyProposal(p.id, "not ready to let this one go").ok).toBe(true);
    const denied = listProposals({ status: "denied" })[0]!;
    expect(denied.denialNote).toBe("not ready to let this one go");

    const ev = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(ev[0]!.note).toContain("not ready");

    expect(approveProposal(p.id).ok).toBe(false);
    expect(denyProposal(p.id).ok).toBe(false);
  });
});
