import type { conversation } from "../db/schema";

type ConversationRow = typeof conversation.$inferSelect;

export type PipelineState =
  | "parse_failed"
  | "idle"
  | "awaiting_distill"
  | "awaiting_review"
  | "awaiting_derive"
  | "derived";

// The conversation FSM, computed from columns — the client contract.
export function pipelineState(c: ConversationRow): PipelineState {
  if (c.parseError) return "parse_failed";
  if (!c.slugDetected && !c.distillRequested) return "idle";
  if (!c.distilledAt) return "awaiting_distill";
  if (!c.extractionsReviewedAt) return "awaiting_review";
  if (!c.derivedAt) return "awaiting_derive";
  return "derived";
}
