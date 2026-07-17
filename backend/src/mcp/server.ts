import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { env } from "../lib/env";
import {
  collaborationContextSections,
  collaborationModes,
  type CollaborationMcpBackend,
  type McpSourceRef,
} from "./contracts";
import { allowedContextSections, collaborationInstructions, draftOperationContract } from "./instructions";

/**
 * A Streamable HTTP connection is the short-lived capability boundary.  The
 * one-time code binds exactly one workspace to it; no subsequent MCP tool is
 * allowed to choose a workspace id for itself.
 */
export interface McpSessionBinding {
  get sessionId(): string | null;
  get workspaceId(): string | null;
  get clientKey(): string;
  bindWorkspace(workspaceId: string): void;
  clearWorkspace(): void;
}

let configuredBackend: CollaborationMcpBackend | null = null;

type RedemptionWindow = { startedAt: number; attempts: number };
const redemptionWindows = new Map<string, RedemptionWindow>();

function allowRedemptionAttempt(clientKey: string) {
  const now = Date.now();
  const windowMs = env.MCP_REDEEM_WINDOW_MINUTES * 60_000;
  // Bound this in-memory limiter too: an unauthenticated caller must not be
  // able to retain an unbounded number of unique client keys until expiry.
  for (const [key, window] of redemptionWindows) {
    if (now - window.startedAt >= windowMs) redemptionWindows.delete(key);
  }
  const maxAttempts = env.MCP_REDEEM_MAX_ATTEMPTS;
  const current = redemptionWindows.get(clientKey);
  if (!current || now - current.startedAt >= windowMs) {
    if (!current && redemptionWindows.size >= env.MCP_REDEEM_MAX_TRACKED_CLIENTS) return false;
    redemptionWindows.set(clientKey, { startedAt: now, attempts: 1 });
    return true;
  }
  if (current.attempts >= maxAttempts) return false;
  current.attempts++;
  return true;
}

/**
 * Installed by the collaboration domain service at application startup.  A
 * deliberately explicit registration keeps this protocol layer from gaining
 * direct Drizzle/database access.
 */
export function configureCollaborationMcpBackend(backend: CollaborationMcpBackend | null) {
  configuredBackend = backend;
}

function resultText(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorText(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function unavailable(): CallToolResult {
  return errorText("Collaboration workspaces are not configured on this server yet.");
}

function currentWorkspace(session: McpSessionBinding): string | CallToolResult {
  return session.workspaceId ?? errorText("Redeem a collaboration code before using workspace tools.");
}

function sourceRefFromTool(input: { entity_type: string; entity_id: string; note?: string }): McpSourceRef {
  return { entityType: input.entity_type, entityId: input.entity_id, note: input.note };
}

const operationSchema = z.object({ type: z.string().trim().min(1) }).catchall(z.unknown());

/**
 * Creates the narrow MCP server used by cloud authoring conversations.  The
 * tool list is intentionally static and tiny: no generic DB CRUD, no calendar
 * calls, and no way to apply the draft from the cloud conversation.
 */
// Shown to the connected agent at initialization, before any tool call. A
// blank cloud agent's first correct move must be discoverable without the
// user explaining the system.
const CREATOR_SERVER_INSTRUCTIONS = `
This is Dream Coach's dashboard-started creation surface. The user begins a
collaboration in their dashboard, which shows them a one-time code; ask for
that code if they have not supplied it, and redeem it with
redeem_collaboration_code before anything else. There is no other way to bind
a workspace, and you must never invent one.

The user names the direction; you never do. After redemption, follow the
returned mode instructions: read the workspace index first, ask only
decision-critical questions, discuss the intended change set in conversation,
and save/submit a draft only after the user explicitly asks you to. Nothing
you write changes their system — every draft is reviewed and applied (or
rejected) in the dashboard.
`.trim();

export function createCollaborationMcpServer(session: McpSessionBinding): McpServer {
  const server = new McpServer(
    {
      name: "dream-coach-collaboration",
      version: "1.0.0",
    },
    { instructions: CREATOR_SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "redeem_collaboration_code",
    {
      title: "Redeem collaboration code",
      description:
        "Redeem the one-time code shown in the Dream Coach dashboard. This is the only way to bind a workspace to this MCP conversation. After success, follow the returned mode instructions and never invent a different primary direction.",
      inputSchema: {
        code: z.string().trim().min(6).max(256).describe("The dashboard's one-time collaboration code"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ code }) => {
      if (session.workspaceId) {
        return errorText("This MCP session is already bound to a workspace. Open a new dashboard code for another collaboration.");
      }
      if (!allowRedemptionAttempt(session.clientKey)) {
        return errorText("Too many collaboration-code redemption attempts. Wait before trying another code.");
      }
      if (!configuredBackend) return unavailable();

      const result = await configuredBackend.redeemCollaborationCode(code);
      if (!result.ok) return errorText(result.error);

      const { workspace } = result.value;
      session.bindWorkspace(workspace.id);
      return resultText({
        workspace,
        instructions_md: collaborationInstructions(workspace.mode),
        draft_operation_contract_md: draftOperationContract(workspace.mode),
        allowed_context_sections: allowedContextSections(workspace.mode),
        next_steps: [
          "Start with get_workspace_index so you understand the named direction, accepted material, and available evidence before asking questions.",
          "Use search_workspace_index, read_entity_context, and follow_provenance to inspect relevant detail; do not treat index relevance as the user's decision.",
          "Ask only for missing decision-critical information.",
          "Summarize the intended atomic change set in the conversation and wait for the user's explicit go-ahead.",
          "Only after that go-ahead, save the one complete atomic draft and submit it for dashboard review.",
          "Do not claim that any organized/raw record, task, calendar event, or witness message was changed.",
        ],
      });
    },
  );

  server.registerTool(
    "get_workspace_index",
    {
      title: "Get code-linked workspace index",
      description:
        "Read the persisted orientation index generated for this redeemed creator workspace. Start here: it maps the user-named direction to accepted proposal-derived material, organized records, IDs, provenance handles, and the permitted drill-down tools. It is evidence, not authorization to invent a direction.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();
      const result = await configuredBackend.getWorkspaceIndex(workspaceId);
      return result.ok ? resultText(result.value) : errorText(result.error);
    },
  );

  server.registerTool(
    "search_workspace_index",
    {
      title: "Search code-linked workspace index",
      description:
        "Search the persisted, workspace-scoped index for a word, theme, or named thing. Use it to find relevant accepted material before requesting detailed context. It cannot search outside this redeemed workspace.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        cursor: z.string().trim().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, cursor, limit }) => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();
      const result = await configuredBackend.searchWorkspaceIndex({ workspaceId, query, cursor, limit });
      return result.ok ? resultText(result.value) : errorText(result.error);
    },
  );

  server.registerTool(
    "read_entity_context",
    {
      title: "Read indexed entity context",
      description:
        "Read current detail for an entity that appears in this workspace index. Supply the reference type and ID returned by the index/search; the server rejects arbitrary database IDs. This is read-only and does not change any record.",
      inputSchema: {
        reference_type: z.string().trim().min(1).max(100),
        entity_id: z.string().trim().min(1).max(200),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ reference_type, entity_id }) => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();
      const result = await configuredBackend.readEntityContext({
        workspaceId,
        referenceType: reference_type,
        entityId: entity_id,
      });
      return result.ok ? resultText(result.value) : errorText(result.error);
    },
  );

  server.registerTool(
    "follow_provenance",
    {
      title: "Follow indexed provenance",
      description:
        "Follow an indexed raw or organized entity through its source links, confirmed extractions, and source conversations. Use citations to ground claims; this read-only tool cannot expose an arbitrary record outside the workspace index.",
      inputSchema: {
        reference_type: z.string().trim().min(1).max(100),
        entity_id: z.string().trim().min(1).max(200),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ reference_type, entity_id }) => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();
      const result = await configuredBackend.followProvenance({
        workspaceId,
        referenceType: reference_type,
        entityId: entity_id,
      });
      return result.ok ? resultText(result.value) : errorText(result.error);
    },
  );

  server.registerTool(
    "get_workspace",
    {
      title: "Get current collaboration workspace",
      description:
        "Read the workspace bound to this MCP session, including its primary entity, user seed, selected goals, and current draft. This cannot access another workspace.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();
      const result = await configuredBackend.getWorkspace(workspaceId);
      return result.ok
        ? resultText({ workspace: result.value, draft_operation_contract_md: draftOperationContract(result.value.mode) })
        : errorText(result.error);
    },
  );

  server.registerTool(
    "get_draft_operation_contract",
    {
      title: "Get the exact draft operation contract",
      description:
        "Read the exact mode-specific JSON operation fields and invariants before saving a draft. This is a read-only schema guide; backend validation remains authoritative.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();
      const result = await configuredBackend.getWorkspace(workspaceId);
      return result.ok
        ? resultText({ mode: result.value.mode, draft_operation_contract_md: draftOperationContract(result.value.mode) })
        : errorText(result.error);
    },
  );

  server.registerTool(
    "read_workspace_context",
    {
      title: "Read scoped collaboration context",
      description:
        "Read a bounded, mode-authorized context section for the redeemed workspace. Use this instead of asking for generic database access. The server rejects sections inappropriate for the workspace mode.",
      inputSchema: {
        section: z.enum(collaborationContextSections).describe("The bounded context section to read"),
        query: z.string().trim().min(1).max(500).optional().describe("Optional focused question or filter"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ section, query }) => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();

      const workspace = await configuredBackend.getWorkspace(workspaceId);
      if (!workspace.ok) return errorText(workspace.error);
      if (!allowedContextSections(workspace.value.mode).includes(section)) {
        return errorText(`The ${section} context section is not available in ${workspace.value.mode} mode.`);
      }

      const result = await configuredBackend.readWorkspaceContext({ workspaceId, section, query });
      return result.ok ? resultText(result.value) : errorText(result.error);
    },
  );

  server.registerTool(
    "save_draft_change_set",
    {
      title: "Save atomic draft change set",
      description:
        "Replace the current workspace draft with one complete, reviewable atomic change set. First read get_draft_operation_contract (or the redemption response) and follow it exactly. This writes only the draft; it never applies organized/raw/calendar/witness state.",
      inputSchema: {
        summary_md: z.string().trim().min(1).max(40_000).describe("Complete markdown rationale for the intended change set"),
        operations: z.array(operationSchema).min(1).max(100).describe("Full structured operation list for this one atomic draft"),
        source_refs: z
          .array(
            z.object({
              entity_type: z.string().trim().min(1).max(100),
              entity_id: z.string().trim().min(1).max(200),
              note: z.string().trim().min(1).max(2_000).optional(),
            }),
          )
          .max(500)
          .default([])
          .describe("Existing raw records that support the draft; organized records belong in operations, not source_refs."),
        audit_note: z.string().trim().min(1).max(4_000).optional().describe("Optional concise note about unresolved uncertainty"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ summary_md, operations, source_refs, audit_note }) => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();

      const result = await configuredBackend.saveDraftChangeSet({
        workspaceId,
        summaryMd: summary_md,
        operations,
        sourceRefs: source_refs.map(sourceRefFromTool),
        auditNote: audit_note,
      });
      return result.ok ? resultText(result.value) : errorText(result.error);
    },
  );

  server.registerTool(
    "submit_draft_for_review",
    {
      title: "Submit draft for dashboard review",
      description:
        "Mark the current draft ready for the dashboard review modal. This does not apply any operation or change real state; the user must explicitly apply or reject the whole change set in Dream Coach.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const workspaceId = currentWorkspace(session);
      if (typeof workspaceId !== "string") return workspaceId;
      if (!configuredBackend) return unavailable();
      const result = await configuredBackend.submitDraftForReview(workspaceId);
      return result.ok ? resultText(result.value) : errorText(result.error);
    },
  );

  return server;
}

export { collaborationModes };
