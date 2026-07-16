import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  companionBranchDraft,
  conversation,
  currentFocus,
  currentFocusGoal,
  experiment,
  experimentGroup,
  experimentGroupContext,
  experimentGroupGoal,
  experimentGroupProject,
  experimentGroupSource,
  experimentGroupTarget,
  extraction,
  extractionLink,
  organizedEnvironmentItem,
  organizedGoal,
  organizedHabit,
  project,
} from "../db/schema";
import { env } from "../lib/env";
import { emit } from "./events";
import {
  GroupTargetSchema,
  SourceRefSchema,
  assertSourcesExist,
  organizedEntityDetail,
  type SourceRef,
} from "./organized";

/**
 * The persistent companion's authenticated caller. `subject` owns the drafts;
 * `reviewerSubject` is the identity the dashboard inbox authorizes against.
 * In the two supported single-user adapters they are the same person.
 */
export type CompanionIdentity = {
  subject: string;
  reviewerSubject: string;
  deploymentMode: "private-local" | "authenticated";
};

const OWNER_SUBJECT = "companion-owner";
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenMatchesConfiguredHash(token: string): boolean {
  const configured = env.COMPANION_AUTH_TOKEN_SHA256;
  if (!/^[0-9a-f]{64}$/.test(configured)) return false;
  const presented = Buffer.from(sha256Hex(token), "hex");
  const expected = Buffer.from(configured, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function isLoopbackPeer(peerAddress: string | undefined | null): boolean {
  return !!peerAddress && LOOPBACK_PEERS.has(peerAddress);
}

/**
 * Fail-closed identity resolution, evaluated on EVERY companion request —
 * initialization and session continuations alike, so an MCP session id never
 * becomes a reusable bearer credential.
 *
 * A multi-user/public deployment must add a real per-user identity boundary;
 * with neither adapter configured this returns null and the endpoint is dead.
 */
export function resolveCompanionIdentity(input: {
  bearerToken?: string | null;
  peerAddress?: string | null;
}): CompanionIdentity | null {
  if (input.bearerToken && tokenMatchesConfiguredHash(input.bearerToken)) {
    return { subject: OWNER_SUBJECT, reviewerSubject: OWNER_SUBJECT, deploymentMode: "authenticated" };
  }
  if (env.COMPANION_ALLOW_LOOPBACK_OWNER && isLoopbackPeer(input.peerAddress)) {
    return { subject: OWNER_SUBJECT, reviewerSubject: OWNER_SUBJECT, deploymentMode: "private-local" };
  }
  return null;
}

export function bearerTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

// ---------------------------------------------------------------------------
// Companion-only operation contract.
//
// Deliberately separate from the creator DraftOperationsSchema so generic
// creator drafts can never acquire lineage authority. The single allowed
// action creates one new candidate branch under an explicit parent; the user
// confirmed (2026-07-16) that related existing-organized updates are out of
// scope — a new idea always becomes a new branch, never an in-place rewrite.
// ---------------------------------------------------------------------------

export const CompanionBranchOperationSchema = z
  .object({
    type: z.literal("create_experiment_group_branch"),
    parentExperimentGroupId: z.string().uuid(),
    title: z.string().min(1).max(300),
    motivationMd: z.string().max(50_000).nullable().optional(),
    organizedGoalIds: z.array(z.string().uuid()).min(1).max(30),
    targets: z.array(GroupTargetSchema).max(100).optional(),
    appendContext: z.array(z.string().min(1).max(30_000)).max(50).optional(),
    projectIds: z.array(z.string().uuid()).max(100).optional(),
    sources: z.array(SourceRefSchema).max(200).optional(),
  })
  .strict();
export const CompanionBranchOperationsSchema = z.array(CompanionBranchOperationSchema).length(1);
export type CompanionBranchOperation = z.infer<typeof CompanionBranchOperationSchema>;

function assertBranchOperationReferences(op: CompanionBranchOperation) {
  const parent = db
    .select({ id: experimentGroup.id })
    .from(experimentGroup)
    .where(eq(experimentGroup.id, op.parentExperimentGroupId))
    .get();
  // An archived parent is fine: branching from a hidden old story is exactly
  // what lineage exists for. A missing parent is not.
  if (!parent) throw new Error("parent experiment group not found");
  const goals = db
    .select({ id: organizedGoal.id, status: organizedGoal.status })
    .from(organizedGoal)
    .where(inArray(organizedGoal.id, op.organizedGoalIds))
    .all();
  const known = new Set(goals.map(row => row.id));
  const missing = op.organizedGoalIds.filter(id => !known.has(id));
  if (missing.length) throw new Error(`organized goal not found: ${missing.join(", ")}`);
  if (goals.some(goalRow => goalRow.status !== "active")) {
    throw new Error("a branch can serve only active organized goals");
  }
  if (op.projectIds?.length) {
    const projects = db.select({ id: project.id }).from(project).where(inArray(project.id, op.projectIds)).all();
    const knownProjects = new Set(projects.map(row => row.id));
    const missingProjects = op.projectIds.filter(id => !knownProjects.has(id));
    if (missingProjects.length) throw new Error(`project not found: ${missingProjects.join(", ")}`);
  }
  if (op.sources) assertSourcesExist(op.sources);
}

// ---------------------------------------------------------------------------
// Draft persistence — the companion's only write surface.
// ---------------------------------------------------------------------------

const SaveBranchDraftSchema = z.object({
  userSeedMd: z.string().trim().min(1).max(20_000),
  summaryMd: z.string().trim().min(1).max(40_000),
  operations: z.unknown(),
  sourceRefs: z.array(SourceRefSchema).max(500).default([]),
  auditNote: z.string().trim().min(1).max(4_000).optional(),
});
export type SaveBranchDraftInput = z.input<typeof SaveBranchDraftSchema>;

function serializeDraft(row: typeof companionBranchDraft.$inferSelect) {
  return {
    id: row.id,
    companionIdentityId: row.companionIdentityId,
    parentExperimentGroupId: row.parentExperimentGroupId,
    userSeedMd: row.userSeedMd,
    summaryMd: row.summaryMd,
    operations: JSON.parse(row.operationsJson) as unknown[],
    sourceRefs: row.sourceRefsJson ? (JSON.parse(row.sourceRefsJson) as SourceRef[]) : [],
    audit: row.auditJson ? (JSON.parse(row.auditJson) as Record<string, unknown>) : null,
    status: row.status,
    rejectionNote: row.rejectionNote,
    appliedAt: row.appliedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export type CompanionBranchDraftView = ReturnType<typeof serializeDraft>;

function openDraftFor(identity: CompanionIdentity) {
  return db
    .select()
    .from(companionBranchDraft)
    .where(
      and(
        eq(companionBranchDraft.companionIdentityId, identity.subject),
        inArray(companionBranchDraft.status, ["drafting", "ready_for_review"]),
      ),
    )
    .orderBy(desc(companionBranchDraft.createdAt))
    .get();
}

/**
 * Creates or revises the identity's one open branch draft. Dashboard feedback
 * returns the same draft to `drafting`, so a revision updates it in place
 * instead of inventing a second primary entity.
 */
export function saveCompanionBranchDraft(identity: CompanionIdentity, input: SaveBranchDraftInput) {
  const parsed = SaveBranchDraftSchema.parse(input);
  const operations = CompanionBranchOperationsSchema.parse(parsed.operations);
  const branch = operations[0]!;
  assertBranchOperationReferences(branch);
  assertSourcesExist(parsed.sourceRefs);

  const audit = {
    savedBy: "companion-mcp",
    deploymentMode: identity.deploymentMode,
    auditNote: parsed.auditNote ?? null,
  };
  const existing = openDraftFor(identity);
  const row = existing
    ? db
        .update(companionBranchDraft)
        .set({
          parentExperimentGroupId: branch.parentExperimentGroupId,
          userSeedMd: parsed.userSeedMd,
          summaryMd: parsed.summaryMd,
          operationsJson: JSON.stringify(operations),
          sourceRefsJson: JSON.stringify(parsed.sourceRefs),
          auditJson: JSON.stringify(audit),
          status: "drafting",
          rejectionNote: null,
        })
        .where(eq(companionBranchDraft.id, existing.id))
        .returning()
        .get()
    : db
        .insert(companionBranchDraft)
        .values({
          companionIdentityId: identity.subject,
          parentExperimentGroupId: branch.parentExperimentGroupId,
          userSeedMd: parsed.userSeedMd,
          summaryMd: parsed.summaryMd,
          operationsJson: JSON.stringify(operations),
          sourceRefsJson: JSON.stringify(parsed.sourceRefs),
          auditJson: JSON.stringify(audit),
          status: "drafting",
        })
        .returning()
        .get();
  emit("companion_branch_draft", row.id, existing ? "companion_branch_draft_revised" : "companion_branch_draft_saved", {
    parentExperimentGroupId: branch.parentExperimentGroupId,
  });
  return serializeDraft(row);
}

export function getCompanionBranchDraft(identity: CompanionIdentity) {
  const row = openDraftFor(identity);
  return row ? serializeDraft(row) : null;
}

/** Marks the open draft ready for dashboard review. Never applies anything. */
export function submitCompanionBranchDraft(identity: CompanionIdentity) {
  const row = openDraftFor(identity);
  if (!row) throw new Error("there is no companion branch draft to submit");
  if (row.status === "ready_for_review") return serializeDraft(row);
  const updated = db
    .update(companionBranchDraft)
    .set({ status: "ready_for_review" })
    .where(eq(companionBranchDraft.id, row.id))
    .returning()
    .get();
  emit("companion_branch_draft", row.id, "companion_branch_draft_submitted", {});
  return serializeDraft(updated);
}

// ---------------------------------------------------------------------------
// Dashboard inbox — same reviewer identity boundary, atomic apply.
// ---------------------------------------------------------------------------

export function listCompanionBranchDrafts(identity: CompanionIdentity) {
  return db
    .select()
    .from(companionBranchDraft)
    .where(eq(companionBranchDraft.companionIdentityId, identity.reviewerSubject))
    .orderBy(desc(companionBranchDraft.updatedAt))
    .all()
    .map(serializeDraft);
}

function reviewerDraft(identity: CompanionIdentity, id: string) {
  const row = db.select().from(companionBranchDraft).where(eq(companionBranchDraft.id, id)).get();
  // A draft owned by another identity is indistinguishable from a missing one.
  if (!row || row.companionIdentityId !== identity.reviewerSubject) return null;
  return row;
}

export function getCompanionBranchDraftForReview(identity: CompanionIdentity, id: string) {
  const row = reviewerDraft(identity, id);
  if (!row) return null;
  const parent = db.select().from(experimentGroup).where(eq(experimentGroup.id, row.parentExperimentGroupId)).get();
  return {
    ...serializeDraft(row),
    parent: parent
      ? { id: parent.id, title: parent.title, status: parent.status, archivedAt: parent.archivedAt }
      : null,
  };
}

/**
 * Applies one reviewed branch draft in one transaction: exactly one new
 * candidate group with its immutable parent link plus its goal/target/
 * project/source/context relations. It cannot touch focus, priorities,
 * actionables, calendar, or witness state, and reject leaves the domain
 * untouched.
 */
export function applyCompanionBranchDraft(identity: CompanionIdentity, id: string) {
  const row = reviewerDraft(identity, id);
  if (!row) return { ok: false as const, error: "companion branch draft not found" };
  if (row.status !== "ready_for_review") {
    return { ok: false as const, error: `draft is ${row.status}, not ready for review` };
  }
  try {
    const result = db.transaction(() => {
      const operations = CompanionBranchOperationsSchema.parse(JSON.parse(row.operationsJson));
      const branch = operations[0]!;
      assertBranchOperationReferences(branch);
      const group = db
        .insert(experimentGroup)
        .values({
          title: branch.title,
          motivationMd: branch.motivationMd ?? null,
          parentExperimentGroupId: branch.parentExperimentGroupId,
          // A branch is never active on creation; only a later reviewed Pick
          // can select it.
          status: "candidate",
        })
        .returning()
        .get();
      for (const organizedGoalId of branch.organizedGoalIds) {
        db.insert(experimentGroupGoal).values({ experimentGroupId: group.id, organizedGoalId }).run();
      }
      for (const target of branch.targets ?? []) {
        db.insert(experimentGroupTarget)
          .values({
            experimentGroupId: group.id,
            kind: target.kind,
            title: target.title,
            detailMd: target.detailMd ?? null,
            status: target.status ?? "pending",
            doneAt: target.status === "done" ? new Date().toISOString() : null,
          })
          .run();
      }
      for (const projectId of branch.projectIds ?? []) {
        db.insert(experimentGroupProject).values({ experimentGroupId: group.id, projectId }).run();
      }
      for (const source of branch.sources ?? []) {
        db.insert(experimentGroupSource)
          .values({ experimentGroupId: group.id, entityType: source.entityType, entityId: source.entityId })
          .run();
      }
      for (const textMd of branch.appendContext ?? []) {
        db.insert(experimentGroupContext).values({ experimentGroupId: group.id, textMd, sourceChangeSetId: row.id }).run();
      }
      const updated = db
        .update(companionBranchDraft)
        .set({ status: "applied", appliedAt: new Date().toISOString() })
        .where(eq(companionBranchDraft.id, row.id))
        .returning()
        .get();
      return { draft: updated, createdGroupId: group.id };
    });
    emit("companion_branch_draft", row.id, "companion_branch_draft_applied", { createdGroupId: result.createdGroupId });
    return { ok: true as const, draft: serializeDraft(result.draft), createdGroupId: result.createdGroupId };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "apply failed" };
  }
}

export function rejectCompanionBranchDraft(
  identity: CompanionIdentity,
  id: string,
  input: { feedback?: string; returnToDrafting?: boolean } = {},
) {
  const row = reviewerDraft(identity, id);
  if (!row) return { ok: false as const, error: "companion branch draft not found" };
  if (row.status === "applied") return { ok: false as const, error: "an applied draft cannot be rejected" };
  const updated = db
    .update(companionBranchDraft)
    .set(
      input.returnToDrafting
        ? { status: "drafting", rejectionNote: input.feedback ?? null, rejectedAt: null }
        : { status: "rejected", rejectionNote: input.feedback ?? null, rejectedAt: new Date().toISOString() },
    )
    .where(eq(companionBranchDraft.id, row.id))
    .returning()
    .get();
  emit("companion_branch_draft", row.id, input.returnToDrafting ? "companion_branch_draft_returned" : "companion_branch_draft_rejected", {
    feedback: input.feedback ?? null,
  });
  return { ok: true as const, draft: serializeDraft(updated) };
}

// ---------------------------------------------------------------------------
// Organized-first read models. The companion starts from the finite organized
// catalog and follows stored relations outward; raw provenance drills are
// gated by the per-session discovered-reference allowlist in the MCP layer.
// ---------------------------------------------------------------------------

function groupSummary(row: typeof experimentGroup.$inferSelect) {
  const goals = db
    .select({ id: organizedGoal.id, title: organizedGoal.title })
    .from(experimentGroupGoal)
    .innerJoin(organizedGoal, eq(experimentGroupGoal.organizedGoalId, organizedGoal.id))
    .where(eq(experimentGroupGoal.experimentGroupId, row.id))
    .all();
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    parentExperimentGroupId: row.parentExperimentGroupId,
    archivedAt: row.archivedAt,
    goals,
  };
}

export function companionOverview() {
  const goals = db.select().from(organizedGoal).orderBy(asc(organizedGoal.createdAt)).all();
  const habits = db.select().from(organizedHabit).orderBy(asc(organizedHabit.createdAt)).all();
  const environment = db.select().from(organizedEnvironmentItem).orderBy(asc(organizedEnvironmentItem.createdAt)).all();
  const groups = db.select().from(experimentGroup).orderBy(desc(experimentGroup.updatedAt)).all();
  const focus = db.select().from(currentFocus).where(eq(currentFocus.status, "current")).get() ?? null;
  const focusGoals = focus
    ? db
        .select({ id: organizedGoal.id, title: organizedGoal.title, priorityRank: currentFocusGoal.priorityRank })
        .from(currentFocusGoal)
        .innerJoin(organizedGoal, eq(currentFocusGoal.organizedGoalId, organizedGoal.id))
        .where(eq(currentFocusGoal.currentFocusId, focus.id))
        .orderBy(asc(currentFocusGoal.priorityRank))
        .all()
    : [];
  const recentFocusHistory = db
    .select()
    .from(currentFocus)
    .where(eq(currentFocus.status, "ended"))
    .orderBy(desc(currentFocus.endedAt))
    .limit(5)
    .all()
    .map(row => ({
      experimentGroupId: row.experimentGroupId,
      entryReason: row.entryReason,
      reasoningMd: row.reasoningMd,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    }));
  return {
    organizedGoals: goals.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priorityRank: row.priorityRank,
      identityClause: row.identityClause,
    })),
    organizedHabits: habits.map(row => ({ id: row.id, title: row.title, status: row.status })),
    organizedEnvironment: environment.map(row => ({ id: row.id, title: row.title, status: row.status })),
    groups: {
      candidate: groups.filter(row => row.status === "candidate").map(groupSummary),
      active: groups.filter(row => row.status === "active").map(groupSummary),
      terminal: groups.filter(row => row.status === "done" || row.status === "sunset").map(groupSummary),
      archivedCount: groups.filter(row => row.status === "archived").length,
      archived: groups.filter(row => row.status === "archived").map(groupSummary),
    },
    currentFocus: focus
      ? {
          experimentGroupId: focus.experimentGroupId,
          reasoningMd: focus.reasoningMd,
          startedAt: focus.startedAt,
          goals: focusGoals,
        }
      : null,
    recentFocusHistory,
  };
}

const organizedContextTypes = ["organized_goal", "organized_habit", "organized_environment", "experiment_group"] as const;
export type OrganizedContextType = (typeof organizedContextTypes)[number];
export const OrganizedContextTypeSchema = z.enum(organizedContextTypes);

export function searchOrganizedContext(query: string, limit = 20) {
  const term = `%${query.trim().toLowerCase().replaceAll("%", "").replaceAll("_", " ")}%`;
  const goalRows = db
    .select({ id: organizedGoal.id, title: organizedGoal.title, status: organizedGoal.status })
    .from(organizedGoal)
    .where(or(like(organizedGoal.title, term), like(organizedGoal.synthesisMd, term), like(organizedGoal.identityClause, term)))
    .limit(limit)
    .all()
    .map(row => ({ type: "organized_goal" as const, ...row }));
  const habitRows = db
    .select({ id: organizedHabit.id, title: organizedHabit.title, status: organizedHabit.status })
    .from(organizedHabit)
    .where(or(like(organizedHabit.title, term), like(organizedHabit.synthesisMd, term), like(organizedHabit.note, term)))
    .limit(limit)
    .all()
    .map(row => ({ type: "organized_habit" as const, ...row }));
  const environmentRows = db
    .select({ id: organizedEnvironmentItem.id, title: organizedEnvironmentItem.title, status: organizedEnvironmentItem.status })
    .from(organizedEnvironmentItem)
    .where(
      or(
        like(organizedEnvironmentItem.title, term),
        like(organizedEnvironmentItem.synthesisMd, term),
        like(organizedEnvironmentItem.note, term),
      ),
    )
    .limit(limit)
    .all()
    .map(row => ({ type: "organized_environment" as const, ...row }));
  const groupRows = db
    .select({
      id: experimentGroup.id,
      title: experimentGroup.title,
      status: experimentGroup.status,
      parentExperimentGroupId: experimentGroup.parentExperimentGroupId,
    })
    .from(experimentGroup)
    .where(or(like(experimentGroup.title, term), like(experimentGroup.motivationMd, term)))
    .limit(limit)
    .all()
    .map(row => ({ type: "experiment_group" as const, ...row }));
  const contextHits = db
    .select({ experimentGroupId: experimentGroupContext.experimentGroupId })
    .from(experimentGroupContext)
    .where(like(experimentGroupContext.textMd, term))
    .limit(limit)
    .all();
  const extraGroupIds = [...new Set(contextHits.map(hit => hit.experimentGroupId))].filter(
    idValue => !groupRows.some(row => row.id === idValue),
  );
  const extraGroups = extraGroupIds.length
    ? db
        .select({
          id: experimentGroup.id,
          title: experimentGroup.title,
          status: experimentGroup.status,
          parentExperimentGroupId: experimentGroup.parentExperimentGroupId,
        })
        .from(experimentGroup)
        .where(inArray(experimentGroup.id, extraGroupIds))
        .all()
        .map(row => ({ type: "experiment_group" as const, ...row, matchedVia: "group context" }))
    : [];
  return {
    query,
    results: [...goalRows, ...habitRows, ...environmentRows, ...groupRows, ...extraGroups].slice(0, limit),
  };
}

/** Full context read for one organized record, including a group's shallow
 * lineage. Returns the raw source refs it exposes so the MCP session can add
 * them to its discovered-reference allowlist. */
export function readOrganizedContext(type: OrganizedContextType, id: string) {
  const detailType =
    type === "organized_goal" ? "goal" : type === "organized_habit" ? "habit" : type === "organized_environment" ? "environment" : "group";
  const detail = organizedEntityDetail(detailType, id);
  if (!detail) return null;
  const sources = (detail as { sources?: SourceRef[] }).sources ?? [];
  return { type, detail, discoveredSources: sources };
}

/**
 * Relation walk from one organized record: lineage, goals, targets, projects,
 * candidate ideas, and prior actionables with their review notes. This is how
 * the companion earns enough context to discuss an idea without a raw dump.
 */
export function followOrganizedRelations(type: OrganizedContextType, id: string) {
  if (type !== "experiment_group") {
    const context = readOrganizedContext(type, id);
    if (!context) return null;
    const groups =
      type === "organized_goal"
        ? db
            .select()
            .from(experimentGroup)
            .innerJoin(experimentGroupGoal, eq(experimentGroupGoal.experimentGroupId, experimentGroup.id))
            .where(eq(experimentGroupGoal.organizedGoalId, id))
            .all()
            .map(row => groupSummary(row.experiment_group))
        : [];
    return { ...context, relatedGroups: groups };
  }
  const group = db.select().from(experimentGroup).where(eq(experimentGroup.id, id)).get();
  if (!group) return null;
  const parent = group.parentExperimentGroupId
    ? db.select().from(experimentGroup).where(eq(experimentGroup.id, group.parentExperimentGroupId)).get() ?? null
    : null;
  const children = db
    .select()
    .from(experimentGroup)
    .where(eq(experimentGroup.parentExperimentGroupId, group.id))
    .orderBy(asc(experimentGroup.createdAt))
    .all();
  const goals = db
    .select({ id: organizedGoal.id, title: organizedGoal.title, status: organizedGoal.status, synthesisMd: organizedGoal.synthesisMd })
    .from(experimentGroupGoal)
    .innerJoin(organizedGoal, eq(experimentGroupGoal.organizedGoalId, organizedGoal.id))
    .where(eq(experimentGroupGoal.experimentGroupId, group.id))
    .all();
  const targets = db.select().from(experimentGroupTarget).where(eq(experimentGroupTarget.experimentGroupId, group.id)).all();
  const projects = db
    .select({ id: project.id, title: project.title, note: project.note })
    .from(experimentGroupProject)
    .innerJoin(project, eq(experimentGroupProject.projectId, project.id))
    .where(eq(experimentGroupProject.experimentGroupId, group.id))
    .all();
  const contexts = db
    .select({ id: experimentGroupContext.id, textMd: experimentGroupContext.textMd, createdAt: experimentGroupContext.createdAt })
    .from(experimentGroupContext)
    .where(eq(experimentGroupContext.experimentGroupId, group.id))
    .orderBy(asc(experimentGroupContext.createdAt))
    .all();
  const actionables = db
    .select({
      id: experiment.id,
      title: experiment.title,
      status: experiment.status,
      weekOf: experiment.weekOf,
      reviewMd: experiment.reviewMd,
      endedAt: experiment.endedAt,
    })
    .from(experiment)
    .where(and(eq(experiment.kind, "actionable"), eq(experiment.experimentGroupId, group.id)))
    .orderBy(desc(experiment.weekOf))
    .all();
  const sources = db
    .select({ entityType: experimentGroupSource.entityType, entityId: experimentGroupSource.entityId })
    .from(experimentGroupSource)
    .where(eq(experimentGroupSource.experimentGroupId, group.id))
    .all() as SourceRef[];
  return {
    type,
    group: groupSummary(group),
    parent: parent ? groupSummary(parent) : null,
    children: children.map(groupSummary),
    goals,
    targets,
    projects,
    contexts,
    actionables,
    sources,
    discoveredSources: sources,
  };
}

/** Raw provenance drill for a reference the session has already discovered
 * through organized-graph traversal: raw entity → confirmed extractions →
 * source conversations. */
export function followCompanionProvenance(ref: SourceRef) {
  const rows = db
    .select({ x: extraction, conversationTitle: conversation.title, conversationDate: conversation.sourceUpdatedAt })
    .from(extractionLink)
    .innerJoin(extraction, eq(extractionLink.extractionId, extraction.id))
    .innerJoin(conversation, eq(extraction.conversationId, conversation.id))
    .where(and(eq(extractionLink.entityType, ref.entityType), eq(extractionLink.entityId, ref.entityId)))
    .all();
  return {
    ref,
    extractions: rows.map(row => ({
      id: row.x.id,
      kind: row.x.kind,
      text: row.x.text,
      conversationId: row.x.conversationId,
      conversationTitle: row.conversationTitle,
      conversationDate: row.conversationDate,
    })),
  };
}
