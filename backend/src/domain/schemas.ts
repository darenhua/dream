import { z } from "zod";

// Agent output contracts — enforced server-side via structured outputs and
// re-validated with zod in the runner.

export const ExtractionKind = z.enum([
  "goal_talk",
  "habit_talk",
  "environment_talk",
  "experience_talk",
  "experiment_idea",
  "feeling",
]);
export type ExtractionKindT = z.infer<typeof ExtractionKind>;

// Distiller: a pure function of the transcript. Spans cite the numbered
// message indices in the projected transcript.
export const DistillerOutput = z.object({
  extractions: z.array(
    z.object({
      kind: ExtractionKind,
      text: z
        .string()
        .describe("the passage distilled in the user's own first-person register, no coaching-speak"),
      start_idx: z.number().int().describe("first message index this passage draws from"),
      end_idx: z.number().int().describe("last message index this passage draws from"),
    }),
  ),
});
export type DistillerOutputT = z.infer<typeof DistillerOutput>;

// Rant detector: the intake gate's classifier. Batched — one verdict per
// conversation in the projected batch; unknown ids are dropped on apply.
export const RantDetectorOutput = z.object({
  conversations: z.array(
    z.object({
      conversation_id: z.string(),
      verdict: z.enum(["candidate", "not_candidate"]),
      note: z
        .string()
        .describe("one short line: why this is (or isn't) self-discovery material worth distilling"),
    }),
  ),
});
export type RantDetectorOutputT = z.infer<typeof RantDetectorOutput>;

const extractionIds = z
  .array(z.string())
  .min(1)
  .describe("ids of the confirmed extractions that justify this proposal — cross-rant citation expected");

// Deriver: extractions × current state → proposed state changes.
export const DeriverProposal = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("goal_create"),
    title: z.string(),
    identity_clause: z.string().describe('"I am becoming someone who..."'),
    synthesis_md: z.string().describe("current understanding of the root cause, citing the extractions"),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("goal_update"),
    goal_id: z.string(),
    title: z.string().optional(),
    identity_clause: z.string().optional(),
    synthesis_md: z.string().optional(),
    reason: z.string(),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("synthesis_update"),
    goal_id: z.string(),
    synthesis_md: z.string(),
    reason: z.string(),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("habit_add"),
    title: z.string().describe("a habit the user ALREADY has — mapping the current self, not aspiration"),
    note: z.string().optional(),
    valence: z.enum(["good", "bad"]).optional(),
    goal_ids: z.array(z.string()).optional().describe("goals whose ideal set this habit belongs to"),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("habit_update"),
    habit_id: z.string(),
    title: z.string().optional(),
    note: z.string().optional(),
    valence: z.enum(["good", "bad"]).optional(),
    status: z
      .enum(["established", "lapsed"])
      .optional()
      .describe("the ONE derived status change: the user's own words say they stopped (or resumed) following through"),
    reason: z.string(),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("environment_add"),
    title: z.string(),
    sub_kind: z.enum(["physical_setup", "obligation", "social"]),
    note: z.string().optional(),
    goal_ids: z.array(z.string()).optional(),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("environment_update"),
    environment_item_id: z.string(),
    title: z.string().optional(),
    note: z.string().optional(),
    sub_kind: z.enum(["physical_setup", "obligation", "social"]).optional(),
    reason: z.string(),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("experience_add"),
    title: z.string(),
    note: z.string().optional(),
    state: z.enum(["planned", "had"]).describe("had = it already happened; planned = the user wants it"),
    extraction_ids: extractionIds,
  }),
  z.object({
    kind: z.literal("experiment_propose"),
    title: z.string(),
    hypothesis_md: z
      .string()
      .describe(
        "why these particular changes, aimed at these goals, work TOGETHER — and why they matter to this user right now, in their own terms",
      ),
    goal_ids: z.array(z.string()).min(1),
    // The scoped-out checklist: an experiment IS a set of concrete changes.
    changes: z
      .array(
        z.object({
          kind: z.enum(["habit_change", "experience", "environment_change"]),
          title: z.string(),
          detail: z.string().describe("what this change concretely constitutes — detailed steps"),
          easier: z.string().describe("how to make it easier / the smallest version that still counts"),
          why: z.string().describe("why this change matters for the user, connected to what they said"),
          extraction_ids: z.array(z.string()).optional().describe("the passages this specific change draws from"),
        }),
      )
      .min(1),
    extraction_ids: extractionIds,
  }),
]);
export type DeriverProposalT = z.infer<typeof DeriverProposal>;

export const DeriverOutput = z.object({ proposals: z.array(DeriverProposal) });
export type DeriverOutputT = z.infer<typeof DeriverOutput>;

// Reviser: re-grounds ONE pending proposal against a rant the user manually
// pointed at. Same kind, revised content, full citations.
export const ReviserOutput = z.object({ proposal: DeriverProposal });
export type ReviserOutputT = z.infer<typeof ReviserOutput>;

// Goal editor (steering a RATIFIED goal): re-emits the complete record —
// idempotent replace, applied only on the user's explicit finish click.
export const GoalEditOutput = z.object({
  title: z.string(),
  identity_clause: z.string().describe('one sharp sentence: "I am becoming someone who..."'),
  synthesis_md: z
    .string()
    .describe("the full multi-paragraph synthesis in the user's register — complete, not a diff"),
});
export type GoalEditOutputT = z.infer<typeof GoalEditOutput>;

// Review writeup drafter: the full experiment recap, from the run's evidence.
export const ReviewWriteupOutput = z.object({
  review_md: z
    .string()
    .describe("the complete review writeup in the user's own register — what was tried, what held, what broke, what's next; failures included, shrink-first language preserved"),
});
export type ReviewWriteupOutputT = z.infer<typeof ReviewWriteupOutput>;

// Witness composer: one friend's goal-filtered share + questions to ask.
export const WitnessShareOutput = z.object({
  body_text: z
    .string()
    .describe("the message to this friend: self-contained (they memorize nothing), factual, warm, no shame framing"),
  follow_up_questions: z
    .array(z.string())
    .min(2)
    .max(3)
    .describe("specific questions the friend can cherry-pick — never 'how's it going'"),
});
export type WitnessShareOutputT = z.infer<typeof WitnessShareOutput>;

// Witness prompter: one piece of conversation ammo tied to live state.
export const WitnessPromptOutput = z.object({
  body_text: z
    .string()
    .describe("one specific, timely conversation starter for the friend, tied to the live experiment or goals in scope"),
});
export type WitnessPromptOutputT = z.infer<typeof WitnessPromptOutput>;

// Schedule agent: one turn of the in-dashboard scheduling chat. The agent
// re-emits the FULL plan each turn; kept flat for structured-output limits.
export const SchedulePlanTurn = z.object({
  message_to_user: z.string(),
  plan: z.object({
    hypothesis_md: z.string(),
    planned_duration_days: z.number().int(),
    bandwidth: z.string(),
    tasks: z.array(
      z.object({
        kind: z.enum(["experience", "purchase", "setup"]),
        title: z.string(),
        detail: z.string().optional(),
        extraction_ids: z.array(z.string()).optional(),
        goal_ids: z
          .array(z.string())
          .optional()
          .describe("ids of the target goals this task addresses (from the target-goals section)"),
        start: z.string().describe("ISO datetime, inside reported free time"),
        end: z.string().describe("ISO datetime"),
      }),
    ),
    habit_blocks: z.array(
      z.object({
        title: z.string(),
        note: z.string().optional(),
        valence: z.enum(["good", "bad"]).optional(),
        goal_ids: z
          .array(z.string())
          .optional()
          .describe("ids of the target goals this habit serves (from the target-goals section)"),
        rrule: z.string().describe('RFC5545, e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR"'),
        preferred_time: z.string().describe('"HH:MM" local'),
        duration_minutes: z.number().int(),
        first_occurrence: z.string().describe("ISO datetime of the first block"),
      }),
    ),
  }),
});
export type SchedulePlanTurnT = z.infer<typeof SchedulePlanTurn>;
export type SchedulePlanT = SchedulePlanTurnT["plan"];
