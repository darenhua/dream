import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CompanionIdentity } from "../services/companion";
import {
  OrganizedContextTypeSchema,
  companionOverview,
  followCompanionProvenance,
  followOrganizedRelations,
  getCompanionBranchDraft,
  readOrganizedContext,
  saveCompanionBranchDraft,
  searchOrganizedContext,
  submitCompanionBranchDraft,
} from "../services/companion";
import type { SourceRef } from "../services/organized";

/**
 * One authenticated companion MCP session. The identity is bound at
 * initialization and re-verified by the transport on every request; the
 * discovered-reference set is defense in depth for raw provenance drills —
 * a raw record can be read only after an organized-graph tool returned it.
 */
export interface CompanionSessionBinding {
  get sessionId(): string | null;
  get identity(): CompanionIdentity;
  hasDiscovered(ref: SourceRef): boolean;
  discover(refs: SourceRef[]): void;
}

export const COMPANION_INSTRUCTIONS = `
You are the user's persistent Dream Coach companion for spontaneous ideas.

There is no code or OTP here: never ask for, accept, store, or redeem a
dashboard collaboration code. That belongs to a different, dashboard-started
creator connection.

The user owns creation direction. You never invent an organized goal, habit,
environment item, change group, or actionable. Your job with a random idea
(a project idea, an experience idea, a partial rant) is to make it feel heard
and contextualized:

1. Start from get_companion_overview: the finite organized goals, habits,
   environment items, change groups, and the current focus.
2. Identify the likely parent change group (or goal context) for the idea
   with search_organized_context / read_organized_context, and only then
   follow relations and raw evidence (follow_organized_relations,
   follow_provenance) as needed. Cite evidence instead of asserting it.
3. Ask only missing decision-critical questions; do not run a questionnaire.
4. Make the outcome explicit in plain language. An idea can be:
   - useful conversational context only, with no retained record;
   - a proposed branch of an existing change group, drafted for dashboard
     review; or
   - raw project/experience material the user should route through the
     existing rant → proposal flow.
5. Only after the user explicitly asks, save_branch_draft and then
   submit_branch_draft. Say "I prepared a branch draft for dashboard review";
   never claim anything was applied or changed. The parent group is never
   modified and the branch is a candidate — a later reviewed Pick decides if
   it becomes current.

You have no tool that mutates organized or raw records, focus, priorities,
actionables, calendars, or witnesses — and you must not imply otherwise.
`.trim();

function resultText(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorText(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const sourceRefInput = {
  entity_type: z.enum(["goal", "habit", "environment_item", "experience", "experiment", "project"]),
  entity_id: z.string().uuid(),
};

export function createCompanionMcpServer(session: CompanionSessionBinding): McpServer {
  const server = new McpServer(
    { name: "dream-coach-companion", version: "1.0.0" },
    { instructions: COMPANION_INSTRUCTIONS },
  );

  server.registerTool(
    "get_companion_overview",
    {
      title: "Get organized overview",
      description:
        "Start here. Returns the user's finite organized goals, habits, environment items, change groups (with lineage and archive counts), the current focus, and recent focus history. This is the companion's starting map; it is not authorization to create anything.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => resultText({ instructions_md: COMPANION_INSTRUCTIONS, overview: companionOverview() }),
  );

  server.registerTool(
    "search_organized_context",
    {
      title: "Search organized context",
      description:
        "Search organized goals, habits, environment items, and change groups (titles, syntheses, group context) for a word or theme. Use it to locate the likely parent for a new idea; it does not search the raw proposal corpus.",
      inputSchema: { query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => resultText(searchOrganizedContext(query, limit)),
  );

  server.registerTool(
    "read_organized_context",
    {
      title: "Read one organized record",
      description:
        "Read full current detail for one organized goal, habit, environment item, or change group, including a group's targets, projects, context notes, and shallow parent/branch lineage. Raw source references it returns become readable through follow_provenance.",
      inputSchema: { type: OrganizedContextTypeSchema, id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ type, id }) => {
      const context = readOrganizedContext(type, id);
      if (!context) return errorText(`${type} ${id} not found`);
      session.discover(context.discoveredSources);
      return resultText(context);
    },
  );

  server.registerTool(
    "follow_organized_relations",
    {
      title: "Follow organized relations",
      description:
        "Walk outward from one organized record: parent/branches, served goals, targets, projects, context notes, and prior actionables with their week reviews. Use this to understand how an idea fits before proposing a branch.",
      inputSchema: { type: OrganizedContextTypeSchema, id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ type, id }) => {
      const relations = followOrganizedRelations(type, id);
      if (!relations) return errorText(`${type} ${id} not found`);
      session.discover(relations.discoveredSources);
      return resultText(relations);
    },
  );

  server.registerTool(
    "follow_provenance",
    {
      title: "Follow raw provenance",
      description:
        "Read the confirmed extractions and source conversations behind one raw source reference that an organized read already returned. Arbitrary database IDs are rejected: identify a parent through the organized graph first.",
      inputSchema: sourceRefInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ entity_type, entity_id }) => {
      const ref = { entityType: entity_type, entityId: entity_id } as SourceRef;
      if (!session.hasDiscovered(ref)) {
        return errorText(
          "That reference has not been returned by an organized context read in this session. Read the related organized record first.",
        );
      }
      return resultText(followCompanionProvenance(ref));
    },
  );

  server.registerTool(
    "get_branch_draft",
    {
      title: "Get the open branch draft",
      description: "Read this identity's current open branch draft, if any, including its status and any dashboard feedback.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => resultText({ draft: getCompanionBranchDraft(session.identity) }),
  );

  server.registerTool(
    "save_branch_draft",
    {
      title: "Save a quarantined branch draft",
      description:
        "Save (or revise, after dashboard feedback) the one open branch draft for dashboard review. Use only after the user explicitly asked to turn the conversation into something reviewable. The single allowed operation is create_experiment_group_branch with a mandatory existing parent; it creates no domain record — the dashboard review does.",
      inputSchema: {
        user_seed_md: z.string().trim().min(1).max(20_000).describe("The user's own idea/seed, in their words"),
        summary_md: z.string().trim().min(1).max(40_000).describe("Markdown rationale: what the branch is, why this parent, cited evidence"),
        operations: z
          .array(z.object({ type: z.string().trim().min(1) }).catchall(z.unknown()))
          .length(1)
          .describe("Exactly one create_experiment_group_branch operation"),
        source_refs: z
          .array(z.object({ ...sourceRefInput, note: z.string().trim().min(1).max(2_000).optional() }))
          .max(500)
          .default([]),
        audit_note: z.string().trim().min(1).max(4_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ user_seed_md, summary_md, operations, source_refs, audit_note }) => {
      try {
        const draft = saveCompanionBranchDraft(session.identity, {
          userSeedMd: user_seed_md,
          summaryMd: summary_md,
          operations,
          sourceRefs: source_refs.map(ref => ({ entityType: ref.entity_type, entityId: ref.entity_id, note: ref.note })),
          auditNote: audit_note,
        });
        return resultText({
          draft,
          note: "This is a draft for dashboard review only. No group exists yet; submit_branch_draft when the user confirms.",
        });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "saving the branch draft failed");
      }
    },
  );

  server.registerTool(
    "submit_branch_draft",
    {
      title: "Submit the branch draft for review",
      description:
        "Mark the open branch draft ready for the dashboard inbox. This changes no domain state; the user applies or rejects the whole draft in Dream Coach.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const draft = submitCompanionBranchDraft(session.identity);
        return resultText({
          draft,
          note: "Submitted for dashboard review. Tell the user it is waiting in the Dream Coach companion inbox; do not claim it was applied.",
        });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : "submitting the branch draft failed");
      }
    },
  );

  return server;
}
