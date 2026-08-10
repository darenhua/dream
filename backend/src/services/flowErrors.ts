// Refusal types thrown by plan-save handlers and mapped to the pack's §7
// strings at the planningFlows boundary. Standalone module so plan services
// and the flow engine can both import them without a cycle.

/** Domain refusal → ERR.invalid_artifact (field-level reason, nothing written). */
export class ArtifactRefusal extends Error {}

/** Baseline moved under the flow → session conflicted + ERR.conflict. */
export class RevisionConflict extends Error {
  constructor(
    public expected: number,
    public found: number,
  ) {
    super(`expected rev ${expected}, found ${found}`);
  }
}
