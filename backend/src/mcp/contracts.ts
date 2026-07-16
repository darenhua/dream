/**
 * The MCP boundary deliberately knows very little about persistence.  The
 * collaboration service implements this adapter; the transport can therefore
 * expose a small, review-only capability without ever becoming a second CRUD
 * API for the database.
 */

export const collaborationModes = [
  "organized_goal",
  "organized_habit",
  "organized_environment",
  "experiment_group",
  "actionable_experiment",
  "prioritize",
] as const;

export type CollaborationMode = (typeof collaborationModes)[number];

export const collaborationContextSections = [
  "primary_context",
  "organized_items",
  "raw_candidates",
  "raw_evidence",
  "groups",
  "actionable_history",
  "projects",
  "experiences",
  "current_focus",
] as const;

export type CollaborationContextSection = (typeof collaborationContextSections)[number];

export interface McpWorkspace {
  id: string;
  mode: CollaborationMode;
  status: "open" | "drafting" | "draft_ready" | "applied" | "rejected" | "expired";
  primaryEntityType: string;
  primaryEntityId: string | null;
  experimentGroupId: string | null;
  /** Present only for the dashboard-initiated pick/sunset focus workflow. */
  prioritizeAction: "pick" | "sunset" | null;
  userSeedMd: string | null;
  selectedOrganizedGoalIds: string[];
  draft: McpDraftChangeSet | null;
}

export interface McpDraftChangeSet {
  id: string;
  status: "drafting" | "ready_for_review" | "applied" | "rejected" | "expired";
  summaryMd: string;
  operations: Record<string, unknown>[];
  sourceRefs: McpSourceRef[];
  /** Dashboard feedback when a reviewer returns this draft for revision. */
  rejectionNote?: string | null;
  updatedAt: string;
}

export interface McpSourceRef {
  entityType: string;
  entityId: string;
  note?: string;
}

/** A persisted, code-linked orientation artifact for a creator workspace. */
export interface McpWorkspaceIndex {
  workspaceId: string;
  indexVersion: number;
  generatedAt: string;
  markdown: string;
  manifest: Record<string, unknown>;
}

export interface McpWorkspaceIndexSearchResult {
  markdown: string;
  matches: Array<{ referenceType: string; id: string; title: string; summary?: string | null }>;
  nextCursor: string | null;
}

export interface RedeemedMcpWorkspace {
  workspace: McpWorkspace;
}

export type McpResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Implemented by services/collaboration.ts once persistence exists.  Every
 * operation is scoped to the one workspace selected by a redeemed MCP
 * session.  It intentionally has no generic entity CRUD methods.
 */
export interface CollaborationMcpBackend {
  redeemCollaborationCode(code: string): Promise<McpResult<RedeemedMcpWorkspace>>;
  getWorkspace(workspaceId: string): Promise<McpResult<McpWorkspace>>;
  readWorkspaceContext(input: {
    workspaceId: string;
    section: CollaborationContextSection;
    query?: string;
  }): Promise<McpResult<{ markdown: string; nextCursor?: string | null }>>;
  getWorkspaceIndex(workspaceId: string): Promise<McpResult<McpWorkspaceIndex>>;
  searchWorkspaceIndex(input: {
    workspaceId: string;
    query: string;
    cursor?: string;
    limit?: number;
  }): Promise<McpResult<McpWorkspaceIndexSearchResult>>;
  readEntityContext(input: {
    workspaceId: string;
    referenceType: string;
    entityId: string;
  }): Promise<McpResult<{ markdown: string }>>;
  followProvenance(input: {
    workspaceId: string;
    referenceType: string;
    entityId: string;
  }): Promise<McpResult<{ markdown: string }>>;
  saveDraftChangeSet(input: {
    workspaceId: string;
    summaryMd: string;
    operations: Record<string, unknown>[];
    sourceRefs: McpSourceRef[];
    auditNote?: string;
  }): Promise<McpResult<McpDraftChangeSet>>;
  submitDraftForReview(workspaceId: string): Promise<McpResult<McpDraftChangeSet>>;
}
