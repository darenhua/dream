# Later build: derive as a tool-loop agent

*Status: designed, not built (2026-07-15). Come back to this if the upgraded L4 deriver (pending-proposal context + trigger transcript windows, shipped the same day) still under-delivers after real use.*

## Why derive outgrows L4

Derive is inherently the most complicated inference in the system: it must converge many rants into few stable records, understand how each extraction sat in its surrounding conversation, and let every additional rant source deepen a record rather than spawn a duplicate. A one-shot call can only reason over whatever the projector guessed to include; the corpus grows without bound, and pre-projecting *everything at full fidelity* (all transcripts) is impossible. An agent loop lets the deriver *decide what to look at*.

## The design

A tool-loop agent (read tools only) that still emits proposals as its sole output. One precision that keeps it safe to run unattended despite the "unattended can never be L2" law: **derive's only writes are proposal rows, which are themselves the approval artifact.** Read-only tools + pending-proposal writes = the membrane is intact; this is "L2-lite", not an executor.

### Engine

Vercel AI SDK tool loop (`generateText` + `tools` + `stopWhen: hasToolCall("submit_derivation")`) — already a dependency, proven on Bun+Bedrock, and native tool-calling does NOT go through the structured-output grammar compiler that the big proposal schema overflows. The Claude Agent SDK was considered for subagent full-rant reading; per the decision rule ("only if it's easy"), scrapped — a transcript-window tool covers the need.

### Tools (all read-only)

- `list_pending_proposals()` — every pending proposal with payload + cited extraction ids. The agent reads this FIRST.
- `search_extractions({ query?, kind?, limit })` — search the confirmed corpus; returns ids, text, conversation title/date, and which entities each already feeds.
- `read_conversation_context({ extraction_id, radius })` — the transcript window around that extraction's span ("the nearest subset of the conversation that sparked it"). This replaces subagent full-rant reading.
- `get_entity({ type, id })` — full record (goal synthesis + evidence trail, habit details, …) for update-shaped proposals.
- `submit_derivation({ actions })` — terminates the loop.

### Actions (amend-first)

```
actions: Array<
  | { type: "create", proposal: DeriverProposal }            // only for uniquely-new material
  | { type: "amend",  proposal_id, payload, added_extraction_ids, reason }  // default move
>
```

`amend` updates a PENDING proposal in place: enriched payload, additional extraction ids, additional `source_conversation_ids` (amendment 8 already renders those as clickable evidence). Grounding is enforced in code for both action types: every cited id must be a confirmed extraction; unknown proposal ids are dropped. Amending is still agent-owns-drafts territory — ratified state remains untouchable.

### The workflow the prompt encodes

1. Read pending proposals. Default posture: the new rant is *another source* for something already proposed → amend it (richer synthesis, new citations), not a sibling duplicate.
2. For each trigger extraction, pull its conversation window when the extracted line alone is ambiguous — the surrounding register is what makes goal syntheses read like a mirror.
3. Search the corpus for prior material on the same themes; cross-rant citation is the norm.
4. Create only when the uniquely-new extractions point at something no pending proposal and no ratified entity accounts for.

### Open issues to resolve at build time

- **Supersession vs. amendments**: `rederiveConversation` supersedes pending proposals by `scopeKey` (`conversation:{id}`). A proposal amended by three rants "belongs" to three conversations; rederiving the original would supersede the merged record. Likely fix: scopeKey becomes the proposal's *birth* conversation and rederive re-runs as an amend pass instead of supersede-and-recreate.
- **Budget semantics**: does an amend count against `MAX_PROPOSALS_PER_DERIVE`? (Probably half-weight or free — amends reduce human load, they don't add to it.)
- **Loop budget**: cap steps (~8) and tool-result sizes; record steps + summed token usage on `agent_run`.
- **Keep the L4 one-shot as the fallback engine** behind a `DERIVE_ENGINE` config knob, exactly like the grammar-limit fallback inside `runStructured` today.
