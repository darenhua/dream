import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type {
  CollaborationContextSection,
  CollaborationMcpBackend,
  McpDraftChangeSet,
  McpResult,
  McpWorkspace,
} from "../mcp/contracts";
import { collaborationInstructions as mcpCollaborationInstructions } from "../mcp/instructions";
import { db } from "../db";
import {
  collaborationInvite,
  collaborationWorkspace,
  conversation,
  draftChangeSet,
  environmentItem,
  experience,
  experiment,
  experimentGroup,
  experimentGroupGoal,
  experimentGroupTarget,
  event,
  extraction,
  extractionLink,
  goal,
  habit,
  project,
} from "../db/schema";
import { emit } from "./events";
import {
  applyDraftOperations,
  assertSourcesExist,
  CollaborationModeSchema,
  confirmedExtractionSources,
  DraftOperationsSchema,
  organizedEntityDetail,
  organizedFeed,
  type CollaborationMode,
  type SourceRef,
  SourceRefSchema,
} from "./organized";

const PRIMARY_TYPE_BY_MODE: Record<CollaborationMode, string> = {
  organized_goal: "organized_goal",
  organized_habit: "organized_habit",
  organized_environment: "organized_environment",
  experiment_group: "experiment_group",
  actionable_experiment: "actionable_experiment",
};

const INVITE_TTL_MS = 30 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

class ExpiredCollaborationCodeError extends Error {
  constructor(readonly inviteId: string) {
    super("collaboration code expired");
  }
}

const CreateInviteSchema = z.object({
  mode: CollaborationModeSchema,
  primaryEntityId: z.string().uuid().nullable().optional(),
  experimentGroupId: z.string().uuid().nullable().optional(),
  // Every workspace begins with an actual user-supplied direction/intent.
  // This must be enforced below the dashboard UI: the MCP is not allowed to
  // manufacture the missing starting idea through a direct API caller.
  userSeedMd: z.string().trim().min(1).max(30_000),
  selectedOrganizedGoalIds: z.array(z.string().uuid()).max(30).optional(),
});

const SaveDraftSchema = z.object({
  summaryMd: z.string().min(1).max(100_000),
  operations: DraftOperationsSchema,
  sourceRefs: z.array(SourceRefSchema).max(500).optional(),
  audit: z.record(z.string(), z.unknown()).optional(),
});

export type CreateInviteInput = z.input<typeof CreateInviteSchema>;
export type SaveDraftInput = z.input<typeof SaveDraftSchema>;

function hashCode(code: string) {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function hashDashboardCapability(capability: string) {
  return createHash("sha256").update(capability).digest("hex");
}

function newCode() {
  // 26 base32 symbols carries 130 bits. It is intentionally copy-friendly
  // rather than a password a human is expected to memorize.
  const bytes = randomBytes(26);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out.match(/.{1,4}/g)!.join("-");
}

function newDashboardCapability() {
  return randomBytes(32).toString("base64url");
}

function hasDashboardCapability(expectedHash: string | null, capability: string | null | undefined) {
  if (!expectedHash || !capability) return false;
  const actualHash = hashDashboardCapability(capability);
  const expected = Buffer.from(expectedHash, "utf8");
  const actual = Buffer.from(actualHash, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function json<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function now() {
  return new Date().toISOString();
}

function isExpired(expiresAt: string) {
  return new Date(expiresAt).getTime() <= Date.now();
}

function modeHasPrimaryEntity(mode: CollaborationMode) {
  return mode !== "actionable_experiment";
}

function ensurePrimaryExists(mode: CollaborationMode, id: string) {
  const type = PRIMARY_TYPE_BY_MODE[mode];
  const found = organizedEntityDetail(
    type === "organized_goal"
      ? "goal"
      : type === "organized_habit"
        ? "habit"
        : type === "organized_environment"
          ? "environment"
          : "group",
    id,
  );
  if (!found) throw new Error(`${type} not found`);
}

function ensureSelectedGoalsExist(ids: string[]) {
  if (!ids.length) return;
  const feed = organizedFeed();
  const known = new Set(feed.goals.map(goal => goal.id));
  const missing = ids.filter(id => !known.has(id));
  if (missing.length) throw new Error(`selected organized goals not found: ${missing.join(", ")}`);
}

export function createCollaborationInvite(input: CreateInviteInput) {
  const parsed = CreateInviteSchema.parse(input);
  if (parsed.mode === "actionable_experiment" && !parsed.experimentGroupId) {
    throw new Error("an actionable-experiment workspace requires an experiment group");
  }
  if (parsed.mode !== "actionable_experiment" && parsed.experimentGroupId) {
    throw new Error("only an actionable-experiment workspace accepts experimentGroupId");
  }
  if (parsed.primaryEntityId && !modeHasPrimaryEntity(parsed.mode)) throw new Error("actionable work cannot target a prior actionable");
  if (parsed.primaryEntityId) ensurePrimaryExists(parsed.mode, parsed.primaryEntityId);
  let selectedGoalIds = parsed.selectedOrganizedGoalIds ?? [];
  // A new change group begins with a deliberate dashboard selection.  The
  // collaboration agent may reason about that selection, but may not decide
  // which organized goals a new group should serve on the user's behalf.
  if (parsed.mode === "experiment_group" && !parsed.primaryEntityId && selectedGoalIds.length === 0) {
    throw new Error("a new experiment-group workspace requires at least one user-selected organized goal");
  }
  // Editing an existing change group carries forward the goals the user
  // originally selected. The MCP may explain or update the group, but it
  // cannot silently rewrite that user-owned scope by opening a fresh code.
  if (parsed.mode === "experiment_group" && parsed.primaryEntityId) {
    const existingGroupGoalIds = db
      .select({ organizedGoalId: experimentGroupGoal.organizedGoalId })
      .from(experimentGroupGoal)
      .where(eq(experimentGroupGoal.experimentGroupId, parsed.primaryEntityId))
      .all()
      .map(row => row.organizedGoalId);
    if (
      selectedGoalIds.length &&
      (selectedGoalIds.length !== existingGroupGoalIds.length || selectedGoalIds.some(id => !existingGroupGoalIds.includes(id)))
    ) {
      throw new Error("an existing group workspace must preserve its selected organized goals");
    }
    selectedGoalIds = existingGroupGoalIds;
  }
  if (parsed.experimentGroupId) {
    const group = db.select().from(experimentGroup).where(eq(experimentGroup.id, parsed.experimentGroupId)).get();
    if (!group || group.status !== "active") throw new Error("active experiment group not found");
    const groupGoalIds = db
      .select({ organizedGoalId: experimentGroupGoal.organizedGoalId })
      .from(experimentGroupGoal)
      .where(eq(experimentGroupGoal.experimentGroupId, group.id))
      .all()
      .map(row => row.organizedGoalId);
    if (selectedGoalIds.length && selectedGoalIds.some(id => !groupGoalIds.includes(id))) {
      throw new Error("actionable goals must be selected by the chosen group");
    }
    if (!selectedGoalIds.length) selectedGoalIds = groupGoalIds;
  }
  ensureSelectedGoalsExist(selectedGoalIds);
  const code = newCode();
  const dashboardCapability = newDashboardCapability();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const row = db
    .insert(collaborationInvite)
    .values({
      mode: parsed.mode,
      primaryEntityType: PRIMARY_TYPE_BY_MODE[parsed.mode],
      primaryEntityId: parsed.primaryEntityId ?? null,
      experimentGroupId: parsed.experimentGroupId ?? null,
      userSeedMd: parsed.userSeedMd,
      selectedOrganizedGoalIdsJson: JSON.stringify(selectedGoalIds),
      secretHash: hashCode(code),
      dashboardSecretHash: hashDashboardCapability(dashboardCapability),
      expiresAt,
    })
    .returning()
    .get();
  emit("collaboration_invite", row.id, "collaboration_invite_created", { mode: row.mode, expiresAt });
  // This is the sole point at which plaintext code is returned. The dashboard
  // displays it for the user to enter into their cloud MCP conversation.
  return { ...serializeInvite(row), code, dashboardCapability };
}

function serializeInvite(row: typeof collaborationInvite.$inferSelect) {
  return {
    id: row.id,
    mode: row.mode as CollaborationMode,
    primaryEntityType: row.primaryEntityType,
    primaryEntityId: row.primaryEntityId,
    experimentGroupId: row.experimentGroupId,
    userSeedMd: row.userSeedMd,
    selectedOrganizedGoalIds: json<string[]>(row.selectedOrganizedGoalIdsJson, []),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    redeemedAt: row.redeemedAt,
    workspaceId: row.workspaceId,
    expired: isExpired(row.expiresAt),
  };
}

function serializeWorkspace(row: typeof collaborationWorkspace.$inferSelect) {
  const drafts = db
    .select()
    .from(draftChangeSet)
    .where(eq(draftChangeSet.workspaceId, row.id))
    .orderBy(desc(draftChangeSet.updatedAt))
    .all()
    .map(serializeChangeSet);
  return {
    id: row.id,
    inviteId: row.inviteId,
    mode: row.mode as CollaborationMode,
    status: row.status,
    primaryEntityType: row.primaryEntityType,
    primaryEntityId: row.primaryEntityId,
    experimentGroupId: row.experimentGroupId,
    userSeedMd: row.userSeedMd,
    selectedOrganizedGoalIds: json<string[]>(row.selectedOrganizedGoalIdsJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    drafts,
  };
}

export function serializeChangeSet(row: typeof draftChangeSet.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    mode: row.mode as CollaborationMode,
    primaryEntityType: row.primaryEntityType,
    primaryEntityId: row.primaryEntityId,
    summaryMd: row.summaryMd,
    operations: json<unknown[]>(row.operationsJson, []),
    sourceRefs: json<SourceRef[]>(row.sourceRefsJson, []),
    audit: json<Record<string, unknown>>(row.auditJson, {}),
    status: row.status,
    rejectionNote: row.rejectionNote,
    appliedAt: row.appliedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getCollaborationInvite(id: string) {
  const row = db.select().from(collaborationInvite).where(eq(collaborationInvite.id, id)).get();
  return row ? serializeInvite(row) : null;
}

/**
 * Dashboard routes are capabilities too. The one-time OTP authorizes an MCP
 * session; this independent 256-bit value authorizes observing and applying
 * the resulting draft from the dashboard that created it.
 */
export function assertDashboardInviteCapability(inviteId: string, capability: string | null | undefined) {
  const invite = db.select().from(collaborationInvite).where(eq(collaborationInvite.id, inviteId)).get();
  if (!invite || !hasDashboardCapability(invite.dashboardSecretHash, capability)) {
    throw new Error("collaboration dashboard capability is invalid");
  }
  return invite;
}

export function assertDashboardWorkspaceCapability(workspaceId: string, capability: string | null | undefined) {
  const workspace = db.select().from(collaborationWorkspace).where(eq(collaborationWorkspace.id, workspaceId)).get();
  if (!workspace) throw new Error("collaboration dashboard capability is invalid");
  assertDashboardInviteCapability(workspace.inviteId, capability);
  return workspace;
}

export function assertDashboardChangeSetCapability(changeSetId: string, capability: string | null | undefined) {
  const changeSet = db.select().from(draftChangeSet).where(eq(draftChangeSet.id, changeSetId)).get();
  if (!changeSet) throw new Error("collaboration dashboard capability is invalid");
  assertDashboardWorkspaceCapability(changeSet.workspaceId, capability);
  return changeSet;
}

/** MCP-only redemption: creates one workspace and consumes the invite code. */
export function redeemCollaborationCode(code: string) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error("code required");
  let workspace: typeof collaborationWorkspace.$inferSelect;
  try {
    workspace = db.transaction(() => {
      const invite = db
        .select()
        .from(collaborationInvite)
        .where(eq(collaborationInvite.secretHash, hashCode(normalized)))
        .get();
      if (!invite) throw new Error("unknown collaboration code");
      if (isExpired(invite.expiresAt)) throw new ExpiredCollaborationCodeError(invite.id);
      if (invite.redeemedAt || invite.workspaceId) throw new Error("collaboration code has already been redeemed");
      const created = db
        .insert(collaborationWorkspace)
        .values({
          inviteId: invite.id,
          mode: invite.mode,
          primaryEntityType: invite.primaryEntityType ?? PRIMARY_TYPE_BY_MODE[invite.mode as CollaborationMode],
          primaryEntityId: invite.primaryEntityId,
          experimentGroupId: invite.experimentGroupId,
          status: "open",
          userSeedMd: invite.userSeedMd,
          selectedOrganizedGoalIdsJson: invite.selectedOrganizedGoalIdsJson ?? "[]",
        })
        .returning()
        .get();
      db.update(collaborationInvite)
        .set({ redeemedAt: now(), workspaceId: created.id })
        .where(eq(collaborationInvite.id, invite.id))
        .run();
      return created;
    });
  } catch (error) {
    if (error instanceof ExpiredCollaborationCodeError) {
      const alreadyAudited = db
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.entityType, "collaboration_invite"),
            eq(event.entityId, error.inviteId),
            eq(event.eventType, "collaboration_invite_expired"),
          ),
        )
        .get();
      if (!alreadyAudited) emit("collaboration_invite", error.inviteId, "collaboration_invite_expired", {});
    }
    throw error;
  }
  emit("collaboration_workspace", workspace.id, "collaboration_code_redeemed", { mode: workspace.mode });
  return {
    workspace: serializeWorkspace(workspace),
    instructionsMd: mcpCollaborationInstructions(workspace.mode as CollaborationMode),
  };
}

export function getCollaborationWorkspace(id: string) {
  const row = db.select().from(collaborationWorkspace).where(eq(collaborationWorkspace.id, id)).get();
  return row ? serializeWorkspace(row) : null;
}

function draftMatchesMode(mode: CollaborationMode, operations: unknown[]) {
  const types = new Set(operations.map((operation: any) => operation.type));
  switch (mode) {
    case "organized_goal":
      return types.has("upsert_organized_goal");
    case "organized_habit":
      return types.has("upsert_organized_habit");
    case "organized_environment":
      return types.has("upsert_organized_environment");
    case "experiment_group":
      return types.has("upsert_experiment_group");
    case "actionable_experiment":
      return types.has("create_actionable_experiment");
  }
}

function assertDraftFitsWorkspace(
  workspace: typeof collaborationWorkspace.$inferSelect,
  operations: z.infer<typeof DraftOperationsSchema>,
) {
  const mode = workspace.mode as CollaborationMode;
  if (!draftMatchesMode(mode, operations)) throw new Error(`draft must contain a primary ${mode} operation`);
  const primaryType =
    mode === "organized_goal"
      ? "upsert_organized_goal"
      : mode === "organized_habit"
        ? "upsert_organized_habit"
        : mode === "organized_environment"
          ? "upsert_organized_environment"
          : mode === "experiment_group"
            ? "upsert_experiment_group"
            : "create_actionable_experiment";
  const primaries = operations.filter(operation => operation.type === primaryType);
  if (primaries.length !== 1) throw new Error(`a ${mode} workspace requires exactly one primary operation`);
  const primary = primaries[0];
  if (!primary) throw new Error("primary operation missing");
  // Existing-item workspaces must revise the item they were explicitly opened
  // for. New workspaces omit id and create exactly the user-initiated item.
  // Zod leaves an omitted optional field absent, so normalize it before
  // comparing; otherwise omitting `id` would accidentally create a duplicate.
  const draftPrimaryId = "id" in primary ? primary.id : undefined;
  if (workspace.primaryEntityId && draftPrimaryId !== workspace.primaryEntityId) {
    throw new Error("draft primary entity does not match this workspace");
  }
  if (!workspace.primaryEntityId && draftPrimaryId !== undefined) {
    throw new Error("a new workspace primary must not target an existing organized entity");
  }
  // A user starts a workspace for exactly one new organized thing. A coherent
  // draft may update related *existing* organized records, but it cannot use a
  // conversation about one direction to invent additional goals, habits,
  // environment items, or groups the user did not explicitly initiate.
  for (const operation of operations) {
    if (operation === primary) continue;
    if (
      (operation.type === "upsert_organized_goal" ||
        operation.type === "upsert_organized_habit" ||
        operation.type === "upsert_organized_environment" ||
        operation.type === "upsert_experiment_group") &&
      !operation.id
    ) {
      throw new Error("a workspace may create only its user-initiated primary organized entity");
    }
  }
  const targetOperations = operations.filter(operation => operation.type === "set_group_target_done");
  if (targetOperations.length) {
    const allowedGroupId =
      mode === "actionable_experiment"
        ? workspace.experimentGroupId
        : mode === "experiment_group"
          ? workspace.primaryEntityId
          : null;
    if (!allowedGroupId) {
      throw new Error("only an existing group workspace or its actionable workspace may update group targets");
    }
    for (const operation of targetOperations) {
      const target = db
        .select({ experimentGroupId: experimentGroupTarget.experimentGroupId })
        .from(experimentGroupTarget)
        .where(eq(experimentGroupTarget.id, operation.targetId))
        .get();
      if (!target || target.experimentGroupId !== allowedGroupId) {
        throw new Error("group target is outside this collaboration workspace");
      }
    }
  }
  if (mode === "actionable_experiment") {
    if (!workspace.experimentGroupId) throw new Error("actionable workspace has no experiment group");
    if (primary.type !== "create_actionable_experiment" || primary.experimentGroupId !== workspace.experimentGroupId) {
      throw new Error("actionable draft must remain scoped to its selected experiment group");
    }
    const selected = json<string[]>(workspace.selectedOrganizedGoalIdsJson, []);
    if (selected.length && primary.organizedGoalIds.some(id => !selected.includes(id))) {
      throw new Error("actionable draft includes goals outside this workspace's selected group goals");
    }
  }
  if (mode !== "actionable_experiment" && operations.some(operation => operation.type === "create_actionable_experiment")) {
    throw new Error("only an actionable-experiment workspace may create an actionable");
  }
  // A full group upsert replaces its selected goal membership, targets, and
  // linked projects. Letting a goal/habit/environment workspace carry one as a
  // secondary operation would let it rewrite a group the user did not open.
  // Group changes remain available in the explicit group workspace; a later
  // narrow append-context operation can be added if cross-entity reflection is
  // needed without exposing that broad replacement surface.
  if (mode !== "experiment_group" && operations.some(operation => operation.type === "upsert_experiment_group")) {
    throw new Error("only an experiment-group workspace may revise a change group");
  }
  if (mode === "experiment_group" && primary.type === "upsert_experiment_group") {
    const selected = json<string[]>(workspace.selectedOrganizedGoalIdsJson, []);
    if (selected.length) {
      const drafted = primary.organizedGoalIds;
      const sameSet = drafted.length === selected.length && drafted.every(id => selected.includes(id));
      if (!sameSet) throw new Error("group draft goals must match the goals the user selected before opening this workspace");
    }
  }
}

/** MCP-only write: creates/updates a draft and never touches organized/raw execution state. */
export function saveCollaborationDraft(workspaceId: string, input: SaveDraftInput) {
  const workspace = db.select().from(collaborationWorkspace).where(eq(collaborationWorkspace.id, workspaceId)).get();
  if (!workspace) throw new Error("workspace not found");
  if (workspace.status !== "open") throw new Error(`workspace is ${workspace.status}, not writable`);
  const parsed = SaveDraftSchema.parse(input);
  const operations = DraftOperationsSchema.parse(parsed.operations);
  assertSourcesExist(parsed.sourceRefs ?? []);
  const mode = workspace.mode as CollaborationMode;
  assertDraftFitsWorkspace(workspace, operations);
  const existing = db
    .select()
    .from(draftChangeSet)
    .where(and(eq(draftChangeSet.workspaceId, workspace.id), eq(draftChangeSet.status, "drafting")))
    .orderBy(desc(draftChangeSet.updatedAt))
    .get();
  const row = existing
    ? db
        .update(draftChangeSet)
        .set({
          summaryMd: parsed.summaryMd,
          operationsJson: JSON.stringify(operations),
          sourceRefsJson: JSON.stringify(parsed.sourceRefs ?? []),
          auditJson: JSON.stringify(parsed.audit ?? {}),
        })
        .where(eq(draftChangeSet.id, existing.id))
        .returning()
        .get()
    : db
        .insert(draftChangeSet)
        .values({
          workspaceId: workspace.id,
          mode,
          primaryEntityType: workspace.primaryEntityType,
          primaryEntityId: workspace.primaryEntityId,
          summaryMd: parsed.summaryMd,
          operationsJson: JSON.stringify(operations),
          sourceRefsJson: JSON.stringify(parsed.sourceRefs ?? []),
          auditJson: JSON.stringify(parsed.audit ?? {}),
          status: "drafting",
        })
        .returning()
        .get();
  emit("draft_change_set", row.id, "collaboration_draft_saved", { workspaceId, mode });
  return serializeChangeSet(row);
}

/** MCP-only submission. The dashboard owns all apply/reject transitions. */
export function submitCollaborationDraft(workspaceId: string) {
  const workspace = db.select().from(collaborationWorkspace).where(eq(collaborationWorkspace.id, workspaceId)).get();
  if (!workspace) throw new Error("workspace not found");
  if (workspace.status !== "open") throw new Error(`workspace is ${workspace.status}, not submittable`);
  const draft = db
    .select()
    .from(draftChangeSet)
    .where(and(eq(draftChangeSet.workspaceId, workspace.id), eq(draftChangeSet.status, "drafting")))
    .orderBy(desc(draftChangeSet.updatedAt))
    .get();
  if (!draft) throw new Error("save a draft before submitting it for review");
  const updated = db.transaction(() => {
    const changeSet = db
      .update(draftChangeSet)
      .set({ status: "ready_for_review" })
      .where(eq(draftChangeSet.id, draft.id))
      .returning()
      .get();
    db.update(collaborationWorkspace).set({ status: "draft_ready" }).where(eq(collaborationWorkspace.id, workspace.id)).run();
    return changeSet;
  });
  emit("draft_change_set", draft.id, "collaboration_draft_submitted", { workspaceId });
  return serializeChangeSet(updated);
}

export function getDraftChangeSet(id: string) {
  const row = db.select().from(draftChangeSet).where(eq(draftChangeSet.id, id)).get();
  return row ? serializeChangeSet(row) : null;
}

export function listDraftChangeSets(status?: string) {
  return db
    .select()
    .from(draftChangeSet)
    .where(status ? eq(draftChangeSet.status, status as typeof draftChangeSet.$inferSelect["status"]) : undefined)
    .orderBy(desc(draftChangeSet.updatedAt))
    .all()
    .map(serializeChangeSet);
}

/** Dashboard-only explicit commit. Every operation is applied in one transaction. */
export function applyCollaborationChangeSet(changeSetId: string) {
  const changeSet = db.select().from(draftChangeSet).where(eq(draftChangeSet.id, changeSetId)).get();
  if (!changeSet) return { ok: false as const, error: "change set not found" };
  if (changeSet.status !== "ready_for_review") return { ok: false as const, error: `change set is ${changeSet.status}` };
  try {
    const result = db.transaction(() => {
      const readyChangeSet = db
        .select()
        .from(draftChangeSet)
        .where(and(eq(draftChangeSet.id, changeSet.id), eq(draftChangeSet.status, "ready_for_review")))
        .get();
      if (!readyChangeSet) throw new Error("change set is no longer ready for review");
      const workspace = db
        .select()
        .from(collaborationWorkspace)
        .where(eq(collaborationWorkspace.id, readyChangeSet.workspaceId))
        .get();
      if (!workspace) throw new Error("collaboration workspace not found");
      const operations = DraftOperationsSchema.parse(JSON.parse(readyChangeSet.operationsJson) as unknown);
      // Recheck the scope at the commit boundary so a stale/tampered draft can
      // never use the dashboard apply action as a broader write capability.
      assertDraftFitsWorkspace(workspace, operations);
      const applied = applyDraftOperations(operations, changeSet.id);
      const appliedAt = now();
      const updated = db
        .update(draftChangeSet)
        .set({ status: "applied", appliedAt })
        .where(and(eq(draftChangeSet.id, changeSet.id), eq(draftChangeSet.status, "ready_for_review")))
        .returning()
        .get();
      if (!updated) throw new Error("change set was reviewed by another request");
      db.update(collaborationWorkspace)
        .set({ status: "applied" })
        .where(eq(collaborationWorkspace.id, changeSet.workspaceId))
        .run();
      return { updated, primaryIds: applied.primaryIds };
    });
    emit("draft_change_set", changeSet.id, "collaboration_change_set_applied", { primaryIds: result.primaryIds });
    return { ok: true as const, changeSet: serializeChangeSet(result.updated), primaryIds: result.primaryIds };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export function rejectCollaborationChangeSet(
  changeSetId: string,
  input: { feedback?: string; returnToDrafting?: boolean } = {},
) {
  const row = db.select().from(draftChangeSet).where(eq(draftChangeSet.id, changeSetId)).get();
  if (!row) return null;
  if (row.status !== "ready_for_review") throw new Error(`change set is ${row.status}`);
  const returnToDrafting = Boolean(input.returnToDrafting);
  const updated = db.transaction(() => {
    const readyChangeSet = db
      .select({ id: draftChangeSet.id, workspaceId: draftChangeSet.workspaceId })
      .from(draftChangeSet)
      .where(and(eq(draftChangeSet.id, row.id), eq(draftChangeSet.status, "ready_for_review")))
      .get();
    if (!readyChangeSet) throw new Error("change set is no longer ready for review");
    const changeSet = db
      .update(draftChangeSet)
      .set({
        status: returnToDrafting ? "drafting" : "rejected",
        rejectionNote: input.feedback ?? null,
        rejectedAt: returnToDrafting ? null : now(),
      })
      .where(and(eq(draftChangeSet.id, row.id), eq(draftChangeSet.status, "ready_for_review")))
      .returning()
      .get();
    if (!changeSet) throw new Error("change set was reviewed by another request");
    db.update(collaborationWorkspace)
      .set({ status: returnToDrafting ? "open" : "rejected" })
      .where(eq(collaborationWorkspace.id, readyChangeSet.workspaceId))
      .run();
    return changeSet;
  });
  emit("draft_change_set", row.id, returnToDrafting ? "collaboration_draft_returned" : "collaboration_change_set_rejected", {
    feedback: input.feedback ?? null,
  });
  return serializeChangeSet(updated);
}

/** Read-only context exposed to an MCP session after code redemption. */
export function collaborationMcpContext(workspaceId: string) {
  const workspace = getCollaborationWorkspace(workspaceId);
  if (!workspace) throw new Error("workspace not found");
  const feed = organizedFeed();
  const candidates = db
    .select()
    .from(experiment)
    .where(eq(experiment.kind, "candidate"))
    .orderBy(desc(experiment.createdAt))
    .all();
  const raw = {
    goals: db.select().from(goal).orderBy(desc(goal.updatedAt)).all(),
    habits: db.select().from(habit).orderBy(desc(habit.updatedAt)).all(),
    environment: db.select().from(environmentItem).orderBy(desc(environmentItem.updatedAt)).all(),
    experiences: db.select().from(experience).orderBy(desc(experience.updatedAt)).all(),
    projects: db.select().from(project).orderBy(desc(project.updatedAt)).all(),
  };
  return { workspace, instructionsMd: mcpCollaborationInstructions(workspace.mode), feed, candidates, raw };
}

export function mcpSourceEvidence(sourceRefs: SourceRef[]) {
  return confirmedExtractionSources(SourceRefSchema.array().parse(sourceRefs));
}

function latestDraft(workspace: ReturnType<typeof getCollaborationWorkspace>) {
  return workspace?.drafts[0] ?? null;
}

function toMcpDraft(row: ReturnType<typeof latestDraft>): McpDraftChangeSet | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as McpDraftChangeSet["status"],
    summaryMd: row.summaryMd,
    operations: row.operations as Record<string, unknown>[],
    sourceRefs: row.sourceRefs.map(source => ({ ...source })),
    rejectionNote: row.rejectionNote,
    updatedAt: row.updatedAt,
  };
}

function toMcpWorkspace(workspace: NonNullable<ReturnType<typeof getCollaborationWorkspace>>): McpWorkspace {
  return {
    id: workspace.id,
    mode: workspace.mode,
    status: workspace.status as McpWorkspace["status"],
    primaryEntityType: workspace.primaryEntityType,
    primaryEntityId: workspace.primaryEntityId,
    experimentGroupId: workspace.experimentGroupId,
    userSeedMd: workspace.userSeedMd,
    selectedOrganizedGoalIds: workspace.selectedOrganizedGoalIds,
    draft: toMcpDraft(latestDraft(workspace)),
  };
}

function mcpOk<T>(value: T): McpResult<T> {
  return { ok: true, value };
}

function mcpError<T = never>(error: unknown): McpResult<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function markdownForContext(
  context: ReturnType<typeof collaborationMcpContext>,
  section: CollaborationContextSection,
  query?: string,
) {
  const workspace = context.workspace;
  const group = workspace.experimentGroupId
    ? organizedEntityDetail("group", workspace.experimentGroupId)
    : workspace.primaryEntityId && workspace.primaryEntityType === "experiment_group"
      ? organizedEntityDetail("group", workspace.primaryEntityId)
      : null;
  const primary = workspace.primaryEntityId
    ? workspace.primaryEntityType === "organized_goal"
      ? organizedEntityDetail("goal", workspace.primaryEntityId)
      : workspace.primaryEntityType === "organized_habit"
        ? organizedEntityDetail("habit", workspace.primaryEntityId)
        : workspace.primaryEntityType === "organized_environment"
          ? organizedEntityDetail("environment", workspace.primaryEntityId)
          : group
    : group;
  const value =
    section === "primary_context"
      ? { workspace, primary, selectedGroup: group }
      : section === "organized_items"
        ? context.feed
        : section === "raw_candidates"
          ? context.candidates
          : section === "groups"
            ? context.feed.groups
            : section === "actionable_history"
              ? (group && "actionables" in group ? group.actionables : context.feed.actionables)
              : section === "projects"
                ? context.raw.projects
                : section === "experiences"
                  ? context.raw.experiences
                  : section === "raw_evidence"
                    ? rawEvidenceContext(query)
                    : {
                      // Evidence is intentionally derived from the workspace's
                      // current draft sources when present. Before a draft,
                      // source-less context exposes the raw corpus summaries,
                      // not arbitrary transcript access.
                      sources: latestDraft(workspace)?.sourceRefs ?? [],
                      confirmedExtractions: mcpSourceEvidence(latestDraft(workspace)?.sourceRefs ?? []),
                      rawGoals: context.raw.goals,
                      rawHabits: context.raw.habits,
                      rawEnvironment: context.raw.environment,
                    };
  const rendered = JSON.stringify(value, null, 2);
  // raw_evidence applies its query against whole extraction records before
  // rendering. A line-level JSON filter would sever the source chain the MCP
  // needs to reason from a citation back to its conversation.
  if (section === "raw_evidence") return rendered;
  if (!query) return rendered;
  const needle = query.toLowerCase();
  // A lightweight bounded filter: it avoids pretending we have full-text
  // search while still letting a cloud agent ask for a focused slice.
  return rendered
    .split("\n")
    .filter(line => line.toLowerCase().includes(needle))
    .slice(0, 300)
    .join("\n");
}

function rawEvidenceContext(query?: string) {
  const needle = query?.trim().toLowerCase();
  const rows = db
    .select({
      id: extraction.id,
      kind: extraction.kind,
      text: extraction.text,
      confirmedAt: extraction.confirmedAt,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      conversationDate: conversation.sourceUpdatedAt,
    })
    .from(extraction)
    .innerJoin(conversation, eq(conversation.id, extraction.conversationId))
    .where(isNotNull(extraction.confirmedAt))
    .orderBy(desc(extraction.confirmedAt))
    .all()
    .filter(row => {
      if (!needle) return true;
      return `${row.kind}\n${row.text}\n${row.conversationTitle ?? ""}`.toLowerCase().includes(needle);
    })
    .slice(0, 200)
    .map(row => ({
      ...row,
      linkedRawEntities: db
        .select({ entityType: extractionLink.entityType, entityId: extractionLink.entityId })
        .from(extractionLink)
        .where(eq(extractionLink.extractionId, row.id))
        .all(),
    }));
  return {
    query: query ?? null,
    matchCount: rows.length,
    confirmedExtractions: rows,
    hint: "Each entry carries its source conversation and the raw entities already linked to that extraction. Use IDs only when they genuinely support this workspace draft.",
  };
}

/**
 * Adapter installed into the MCP transport at API startup.  The MCP package
 * never receives a database handle: all it can do is invoke this workspace-
 * scoped, draft-only interface.
 */
export const collaborationMcpBackend: CollaborationMcpBackend = {
  async redeemCollaborationCode(code) {
    try {
      const redeemed = redeemCollaborationCode(code);
      return mcpOk({ workspace: toMcpWorkspace(redeemed.workspace) });
    } catch (error) {
      return mcpError(error);
    }
  },
  async getWorkspace(workspaceId) {
    const workspace = getCollaborationWorkspace(workspaceId);
    if (!workspace) return mcpError("workspace not found");
    emit("collaboration_workspace", workspaceId, "collaboration_workspace_read", {});
    return mcpOk(toMcpWorkspace(workspace));
  },
  async readWorkspaceContext({ workspaceId, section, query }) {
    try {
      const value = { markdown: markdownForContext(collaborationMcpContext(workspaceId), section, query), nextCursor: null };
      emit("collaboration_workspace", workspaceId, "collaboration_context_read", { section, hasQuery: Boolean(query) });
      return mcpOk(value);
    } catch (error) {
      return mcpError(error);
    }
  },
  async saveDraftChangeSet({ workspaceId, summaryMd, operations, sourceRefs, auditNote }) {
    try {
      const draft = saveCollaborationDraft(workspaceId, {
        summaryMd,
        operations: DraftOperationsSchema.parse(operations),
        sourceRefs: SourceRefSchema.array().parse(
          sourceRefs.map(source => ({ entityType: source.entityType, entityId: source.entityId, note: source.note })),
        ),
        audit: auditNote ? { note: auditNote } : {},
      });
      return mcpOk(toMcpDraft(draft)!);
    } catch (error) {
      return mcpError(error);
    }
  },
  async submitDraftForReview(workspaceId) {
    try {
      return mcpOk(toMcpDraft(submitCollaborationDraft(workspaceId))!);
    } catch (error) {
      return mcpError(error);
    }
  },
};
