import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import {
  conversation,
  environmentItem,
  experience,
  experiment,
  experimentGoal,
  extraction,
  extractionLink,
  goal,
  goalEvidence,
  goalHabit,
  habit,
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

function makeExtraction(conversationId: string, kind = "goal_talk" as const, confirmed = true) {
  return db
    .insert(extraction)
    .values({
      conversationId,
      kind,
      text: "I keep saying I want to wake up at 6am",
      contentHash: "h",
      origin: "agent",
      confirmedAt: confirmed ? new Date().toISOString() : null,
    })
    .returning()
    .get();
}

function makeGoal(title = "wake at 6am", status: "active" | "backlog" = "active") {
  return db.insert(goal).values({ title, status, origin: "derived" }).returning().get();
}

function linksFor(entityType: string, entityId: string) {
  return db
    .select()
    .from(extractionLink)
    .where(and(eq(extractionLink.entityType, entityType), eq(extractionLink.entityId, entityId)))
    .all();
}

let convo: ReturnType<typeof makeConversation>;
let x1: ReturnType<typeof makeExtraction>;

beforeEach(() => {
  wipeAllTables();
  seedConfig();
  convo = makeConversation();
  x1 = makeExtraction(convo.id);
});

describe("apply-switch per kind, with provenance", () => {
  test("goal_create → active goal + extraction_link receipts", () => {
    const p = createProposal(
      "goal_create",
      {
        kind: "goal_create",
        title: "wake at 6am",
        identity_clause: "I am becoming someone who owns his mornings",
        synthesis_md: "the mornings keep coming up",
        extraction_ids: [x1.id],
      },
      `conversation:${convo.id}`,
      null,
    );
    const result = approveProposal(p.id);
    expect(result.ok).toBe(true);

    const created = db.select().from(goal).where(eq(goal.title, "wake at 6am")).get()!;
    expect(created.status).toBe("active");
    expect(created.sortOrder).toBe(1);
    const links = linksFor("goal", created.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.extractionId).toBe(x1.id);
    expect(links[0]!.proposalId).toBe(p.id);
  });

  test("goal_create overflow lands in backlog (MAX_ACTIVE_GOALS)", () => {
    setConfig("MAX_ACTIVE_GOALS", 1);
    makeGoal("existing", "active");
    const p = createProposal(
      "goal_create",
      { kind: "goal_create", title: "overflow", identity_clause: "x", synthesis_md: "y", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    const result = approveProposal(p.id);
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("backlog");
    expect(db.select().from(goal).where(eq(goal.title, "overflow")).get()!.status).toBe("backlog");
  });

  test("goal_update rewrites fields + evidence note + provenance", () => {
    const g = makeGoal();
    const p = createProposal(
      "goal_update",
      {
        kind: "goal_update",
        goal_id: g.id,
        identity_clause: "I am becoming someone who sleeps like an adult",
        reason: "the evidence shifted from waking to sleeping",
        extraction_ids: [x1.id],
      },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    const updated = db.select().from(goal).where(eq(goal.id, g.id)).get()!;
    expect(updated.identityClause).toContain("sleeps like an adult");
    expect(linksFor("goal", g.id)).toHaveLength(1);
    const evidence = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(evidence.some(e => e.note?.includes("shifted"))).toBe(true);
  });

  test("synthesis_update rewrites synthesis only", () => {
    const g = makeGoal();
    const p = createProposal(
      "synthesis_update",
      { kind: "synthesis_update", goal_id: g.id, synthesis_md: "new synthesis", reason: "r", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    expect(db.select().from(goal).where(eq(goal.id, g.id)).get()!.synthesisMd).toBe("new synthesis");
  });

  test("goal_status → terminal states succeed; activation respects the cap", () => {
    const g = makeGoal();
    const p = createProposal(
      "goal_status",
      { kind: "goal_status", goal_id: g.id, status: "succeeded", reason: "habit truly built", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    expect(db.select().from(goal).where(eq(goal.id, g.id)).get()!.status).toBe("succeeded");

    setConfig("MAX_ACTIVE_GOALS", 1);
    makeGoal("hog", "active");
    const backlogGoal = makeGoal("wants in", "backlog");
    const p2 = createProposal(
      "goal_status",
      { kind: "goal_status", goal_id: backlogGoal.id, status: "active", reason: "r", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    const r2 = approveProposal(p2.id);
    expect(r2.ok).toBe(true);
    expect(r2.notes.join(" ")).toContain("backlog");
  });

  test("habit_add → established habit (mapping the current self) + goal ideal-set links", () => {
    const g = makeGoal();
    const p = createProposal(
      "habit_add",
      {
        kind: "habit_add",
        title: "evening walks",
        valence: "good",
        goal_ids: [g.id],
        extraction_ids: [x1.id],
      },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    const h = db.select().from(habit).where(eq(habit.title, "evening walks")).get()!;
    expect(h.status).toBe("established"); // never "building" via derive
    expect(h.origin).toBe("derived");
    expect(linksFor("habit", h.id)).toHaveLength(1);
    expect(
      db.select().from(goalHabit).where(and(eq(goalHabit.goalId, g.id), eq(goalHabit.habitId, h.id))).get(),
    ).toBeTruthy();
  });

  test("habit_update + habit_prune (statuses only, nothing deleted)", () => {
    const h = db
      .insert(habit)
      .values({ title: "doomscrolling", valence: "bad", status: "established", origin: "manual" })
      .returning()
      .get();
    const p = createProposal(
      "habit_prune",
      { kind: "habit_prune", habit_id: h.id, reason: "contradicted", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    const after = db.select().from(habit).where(eq(habit.id, h.id)).get()!;
    expect(after.status).toBe("lapsed"); // row survives
  });

  test("environment_add (obligation) + environment_prune", () => {
    const p = createProposal(
      "environment_add",
      {
        kind: "environment_add",
        title: "weekly improv class",
        sub_kind: "obligation",
        extraction_ids: [x1.id],
      },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    const e = db.select().from(environmentItem).where(eq(environmentItem.title, "weekly improv class")).get()!;
    expect(e.subKind).toBe("obligation");
    expect(linksFor("environment_item", e.id)).toHaveLength(1);

    const p2 = createProposal(
      "environment_prune",
      { kind: "environment_prune", environment_item_id: e.id, reason: "quit the class", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p2.id).ok).toBe(true);
    expect(db.select().from(environmentItem).where(eq(environmentItem.id, e.id)).get()!.status).toBe("removed");
  });

  test("experience_add is append-only evidence of a life", () => {
    const p = createProposal(
      "experience_add",
      { kind: "experience_add", title: "first improv show", state: "had", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    const e = db.select().from(experience).where(eq(experience.title, "first improv show")).get()!;
    expect(e.state).toBe("had");
    expect(e.hadAt).toBeTruthy();
    expect(linksFor("experience", e.id)).toHaveLength(1);
  });

  test("experiment_propose → queued experiment + goal links + provenance", () => {
    const g = makeGoal();
    const p = createProposal(
      "experiment_propose",
      {
        kind: "experiment_propose",
        title: "phone out of the bedroom",
        hypothesis_md: "removing the phone removes the morning scroll",
        goal_ids: [g.id],
        extraction_ids: [x1.id],
      },
      `conversation:${convo.id}`,
      null,
    );
    expect(approveProposal(p.id).ok).toBe(true);
    const exp = db.select().from(experiment).where(eq(experiment.title, "phone out of the bedroom")).get()!;
    expect(exp.status).toBe("queued");
    expect(exp.queuedAt).toBeTruthy();
    expect(exp.proposalId).toBe(p.id);
    expect(
      db
        .select()
        .from(experimentGoal)
        .where(and(eq(experimentGoal.experimentId, exp.id), eq(experimentGoal.goalId, g.id)))
        .get(),
    ).toBeTruthy();
    expect(linksFor("experiment", exp.id)).toHaveLength(1);
  });

  test("a failed apply leaves the proposal pending", () => {
    const p = createProposal(
      "goal_update",
      { kind: "goal_update", goal_id: "nope", reason: "r", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    const result = approveProposal(p.id);
    expect(result.ok).toBe(false);
    expect(listProposals({ status: "pending" })).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("citedExtractions hydrate on list — the review card shows the user's own words", () => {
    createProposal(
      "goal_create",
      { kind: "goal_create", title: "t", identity_clause: "i", synthesis_md: "s", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    const [listed] = listProposals({ status: "pending" });
    expect(listed!.citedExtractions).toHaveLength(1);
    expect((listed!.citedExtractions[0] as any).text).toContain("6am");
  });

  test("supersession is scoped to one conversation (re-derive only)", () => {
    const otherConvo = makeConversation("other");
    createProposal(
      "goal_create",
      { kind: "goal_create", title: "a", identity_clause: "i", synthesis_md: "s", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    createProposal(
      "goal_create",
      { kind: "goal_create", title: "b", identity_clause: "i", synthesis_md: "s", extraction_ids: [x1.id] },
      `conversation:${otherConvo.id}`,
      null,
    );
    expect(supersedePending(`conversation:${convo.id}`)).toBe(1);
    const pending = listProposals({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.scopeKey).toBe(`conversation:${otherConvo.id}`);
  });

  test("deny stores note as goal evidence and cannot re-resolve", () => {
    const g = makeGoal();
    const p = createProposal(
      "goal_status",
      { kind: "goal_status", goal_id: g.id, status: "irrelevant", reason: "r", extraction_ids: [x1.id] },
      `conversation:${convo.id}`,
      null,
    );
    expect(denyProposal(p.id, "not yet — still matters to me").ok).toBe(true);
    const evidence = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(evidence.some(e => e.note?.startsWith("denied:"))).toBe(true);
    expect(denyProposal(p.id).ok).toBe(false);
    expect(approveProposal(p.id).ok).toBe(false);
  });
});
