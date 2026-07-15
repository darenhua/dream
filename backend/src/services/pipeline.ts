import type { conversation } from "../db/schema";

type ConversationRow = typeof conversation.$inferSelect;

export type PipelineState =
  | "parse_failed"
  | "pending_detection"
  | "rant_candidate"
  | "rejected"
  | "idle"
  | "awaiting_distill"
  | "awaiting_review"
  | "awaiting_derive"
  | "derived";

// The conversation FSM, computed from columns — the client contract.
// Intake gate first: detection verdict → human accept/reject → distill chain.
export function pipelineState(c: ConversationRow): PipelineState {
  if (c.parseError) return "parse_failed";
  // distilledAt covers legacy slug-era rows that never passed the intake gate.
  if (c.rantStatus === "accepted" || c.distillRequested || c.distilledAt) {
    if (!c.distilledAt) return "awaiting_distill";
    if (!c.extractionsReviewedAt) return "awaiting_review";
    if (!c.derivedAt) return "awaiting_derive";
    return "derived";
  }
  if (c.rantStatus === "proposed") return "rant_candidate";
  if (c.rantStatus === "rejected") return "rejected";
  if (c.rantVerdict === "not_candidate") return "idle"; // organized, not a rant
  return "pending_detection";
}
