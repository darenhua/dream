import { z } from "zod";

// Agent output contracts — enforced server-side via structured outputs and
// re-validated with zod in the runner.

export const CategorizerOutput = z.object({
  categorizations: z.array(
    z.object({
      category_id: z.string().optional(),
      new_category: z.object({ name: z.string(), description: z.string() }).optional(),
      justification: z.string(),
    }),
  ),
  registry_adds: z.array(
    z.object({
      kind: z.enum(["habit", "environment", "experience"]),
      title: z.string(),
      note: z.string().optional(),
      valence: z.enum(["good", "bad"]).optional(),
    }),
  ),
});
export type CategorizerOutputT = z.infer<typeof CategorizerOutput>;

const sourceIds = z
  .array(z.string())
  .describe("ids of the rant conversations that justify this proposal");

export const DeriverProposal = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("goal_create"),
    title: z.string(),
    identity_clause: z.string().describe('"I am becoming someone who..."'),
    synthesis_md: z.string().describe("current understanding of the root cause, citing rants"),
    source_conversation_ids: sourceIds,
  }),
  z.object({
    kind: z.literal("goal_update"),
    goal_id: z.string(),
    title: z.string().optional(),
    identity_clause: z.string().optional(),
    synthesis_md: z.string().optional(),
    reason: z.string(),
    source_conversation_ids: sourceIds,
  }),
  z.object({
    kind: z.literal("synthesis_update"),
    goal_id: z.string(),
    synthesis_md: z.string(),
    reason: z.string(),
    source_conversation_ids: sourceIds,
  }),
  z.object({
    kind: z.literal("goal_status"),
    goal_id: z.string(),
    status: z.enum(["active", "backlog", "dormant", "retired"]),
    reason: z.string(),
    source_conversation_ids: sourceIds,
  }),
  z.object({
    kind: z.literal("registry_add"),
    registry_kind: z.enum(["habit", "environment", "experience"]),
    title: z.string(),
    note: z.string().optional(),
    valence: z.enum(["good", "bad"]).optional(),
    source_conversation_ids: sourceIds,
  }),
  z.object({
    kind: z.literal("registry_prune"),
    registry_item_id: z.string(),
    reason: z.string().describe("contradicted by recent evidence"),
    source_conversation_ids: sourceIds,
  }),
]);
export type DeriverProposalT = z.infer<typeof DeriverProposal>;

export const DeriverOutput = z.object({ proposals: z.array(DeriverProposal) });
export type DeriverOutputT = z.infer<typeof DeriverOutput>;

// §8.6 — the JSON block the experiment prompt-package asks Claude to output,
// pasted back by the user. Field-level errors surface in the dashboard.
export const ExperimentDraft = z.object({
  title: z.string().min(1),
  reasoning_md: z.string(),
  goal_ids: z.array(z.string()),
  levers_json: z.object({
    experience: z.string().optional(),
    habit_changes: z.array(z.string()).optional(),
    environment_changes: z.array(z.string()).optional(),
  }),
  actions_json: z.array(z.object({ when: z.string(), then: z.string() })).min(1),
  bandwidth: z.enum(["tiny", "normal", "lots"]),
});
export type ExperimentDraftT = z.infer<typeof ExperimentDraft>;
