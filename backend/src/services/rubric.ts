// Rubric v1 (PLANNING_REVAMP_SPEC §11.3/§11.4) — the single source of the
// quality bar. Three consumers share this text so they can never drift:
// the MCP server instructions (the conversation agent optimizes for it while
// the plan is being made), the planning-context payloads (qualityBar), and
// the eval judge (Phase 7). Tune it via evals, not by vibes.

export const PLAN_RUBRIC = `
AN EFFECTIVE DAILY PLAN (all ten, no exceptions):
1. Want-grounded: the top priority traces to the pick's goals/theme in the
   user's own phrasing — "because I want X" is recoverable from the plan.
2. Theme steers, not labels: a one-liner usable in micro-decisions all day,
   coherent with the week direction and month theme — not a task title.
3. Selection, not creation: chains come from the armed weekly menu; missions
   echo candidateMissions. Mid-week invention is a flag, not a feature.
4. Feasible for the reported state: matches described energy/capacity; ≤2-3
   chains; blocks sit in real calendar gaps; time estimates doubled.
5. Laughably small start: the first domino passes the shoelace test —
   physical, zero-decision, doable half-asleep, one breath.
6. Minimum viable day is real: genuinely smaller than the plan, still
   meaningful, phrased so completing it reads as a win, not a consolation.
7. Completion-testable priority: at day's end "did it happen?" has a yes/no
   answer. "Work on X" / "make progress on Y" fail this line.
8. Cue-anchored: every chain ties to a real-world cue that will actually
   occur that day, at a time the calendar supports.
9. Not the path of least resistance: where yesterday's evidence says change,
   the plan changes. A deliberately easy day is fine when the reported state
   says so out loud.
10. User's voice, zero slop: the user's phrasings survive into the fields.
    No praise adjectives, no filler, no invented context.
`.trim();

export const WINS_RUBRIC = `
AN EFFECTIVE WIN LIST / RECAP (all eight):
1. Evidence, not evaluation: concrete past-tense facts; the facts do the
   praising. No "amazing", no "great job".
2. Undeniable: specific enough to resist the brain's erasure — numbers,
   names, artifacts ("shipped the 40-min set to Alex").
3. User's voice: near-verbatim phrasing survives; identity evidence phrased
   "acted like someone who…".
4. Complete harvest: actions, courage, self-care, identity evidence, one
   self-recognition line, one lesson — swept from what was actually said,
   never invented.
5. Concise enough to re-read for confidence: each line one breath; the whole
   list readable in ~30 seconds. It is the morning motivation artifact.
6. Trajectory-only comparison: against the user's own history, never an
   imaginary ideal or other people.
7. Tomorrow's first domino present.
8. No shame residue: what didn't happen appears only as mechanical restart
   material ("what broke → smallest restart"), or not at all.
`.trim();

/** Compact form embedded in planning-context payloads. Wins are deferred
 * scope (ruling R4): no wins rubric ships into any planning context — the
 * WINS_RUBRIC export above survives only for a future non-planning surface. */
export const QUALITY_BAR = { plan: PLAN_RUBRIC };
