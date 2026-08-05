import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { weeklyPlan, weeklyPlanChain } from "../db/schema";
import { addDaysStr, localDate, localMinutes, minToHhmm, mondayOf } from "../lib/time";
import { chainHead, chainLibrary, eraChainLibrary } from "./chains";
import { getConfig } from "./config";
import { activePlanFor, recentDailyPlans } from "./dailyPlanV2";
import { activeEra, latestEra } from "./monthlyPlans";
import { getPlanDoc } from "./planDocs";
import { latestPick } from "./prioritize";
import { lineageHead } from "./records";

// The planning oracle (TARGET_SPEC v2 §4.1, migration WO-1): ONE read that
// interprets DB state and returns a Markdown briefing — facts, the likely
// flow, and the exact opening move to speak. The server interprets; the
// agent never reconstructs the domain from raw payloads.
//
// Laws enforced here, not in prose: no wins, no unreviewed days, no undone
// work, ever (no-shame). Fact vs. inference always marked. Refuse-vs-degrade
// (TARGET §7): absent parent routes forward to creating it; thin parent
// proceeds and deepens (effort cascade). Lateness is an energy signal.
// Budget: the whole briefing is speakable in ~15 seconds.
//
// Shape: loadPlanningFacts (DB + clock, thin) → interpretPlanningState
// (PURE — all judgment) → renderBriefing (PURE — markdown). The pure seams
// are unit-tested with zero DB across the WO-1 state matrix.

// ── Clock thresholds (WO-1 forced decision D1; tune here, in daylight) ─────
export const ORACLE_CLOCK = {
  /** From this local minute on, "the daily" means tomorrow. */
  eveningCutoverMin: 17 * 60,
  lateMin: 21 * 60, // getting late — favor the floor
  veryLateMin: 23 * 60, // keep this one short
  afterMidnightEndMin: 4 * 60, // 00:00–03:59 — the today/tomorrow question
} as const;

/** Below this many story characters a monthly era counts as floor-thin. */
export const THIN_STORY_CHARS = 200;

// ── Types ──────────────────────────────────────────────────────────────────

export type Horizon = "monthly" | "weekly" | "daily";
export type Substance = "absent" | "thin" | "substantial";
export type Lateness = "none" | "late" | "very-late" | "after-midnight";

export type PlanningFacts = {
  now: { date: string; time: string; minutes: number; timezone: string; dayOfWeek: number };
  era: {
    focusId: string;
    theme: string | null;
    /** The monthly one-pager doc (pre-WO-3 adapter — see loadEraSubstance). */
    story: string | null;
    periodStart: string;
    periodEnd: string | null;
    expired: boolean;
  } | null;
  weekly: {
    targetWeekStart: string;
    plan: { id: string; weekOf: string; theme: string | null; chainCount: number } | null;
    priorThemes: { weekOf: string; theme: string | null }[];
    /** The most recent PRIOR week's chains — the carryover check's raw material. */
    priorWeekChains: { lineageId: string; trigger: string; status: string }[];
  };
  daily: {
    today: { date: string; plan: { id: string; theme: string | null } | null };
    tomorrow: { date: string; plan: { id: string; theme: string | null } | null };
    priorThemes: { date: string; theme: string | null }[];
  };
  chains: { active: number; draft: number; retired: number };
};

export type CandidateFlow = {
  horizon: Horizon;
  operation: "create" | "update";
  targetPeriod: string; // era focusId / weekOf / date
  reason: string;
  rank: number;
};

export type Ambiguity = { kind: "update-vs-fresh" | "today-vs-tomorrow" | "horizon"; question: string };

export type Interpretation = {
  facts: PlanningFacts;
  parentSubstance: { monthly: Substance; weekly: Substance };
  candidates: CandidateFlow[];
  ambiguities: Ambiguity[];
  /** Set when the requested/likely flow cannot run because its parent is absent. */
  blockedBy: { horizon: Horizon; missingParent: Horizon } | null;
  energy: { lateness: Lateness; note: string | null };
  openingMove: { kind: "menu" | "single-offer" | "parent-route"; lines: string[] };
  /** Live schema/data conflicts, surfaced verbatim — never silently resolved. */
  conflicts: string[];
  dailyTarget: { date: string; label: "today" | "tomorrow" };
};

// ── Loaders (reuse existing builders; nothing new is stored) ───────────────

/** Monthly-era substance (WO-3): monthly_plan is the top horizon. Legacy
 * pick/group adapter remains as a FALLBACK for pre-migration live data only;
 * once a monthly_plan exists it always wins. Promises are never faked from
 * old records (anti-path #7: silent import). */
function loadEraSubstance(pick: ReturnType<typeof latestPick>, forDate: string): PlanningFacts["era"] {
  const era = activeEra(forDate);
  if (era)
    return {
      focusId: era.id,
      theme: era.theme,
      story: era.story,
      periodStart: era.periodStart,
      periodEnd: era.periodEnd,
      expired: false,
    };
  const past = latestEra();
  if (past)
    return {
      focusId: past.id,
      theme: past.theme,
      story: past.story,
      periodStart: past.periodStart,
      periodEnd: past.periodEnd,
      expired: true,
    };
  // Legacy fallback: the pick pair, until the first real era is saved.
  if (!pick) return null;
  const head = lineageHead("experiment_group", pick.groupLineageId) as
    | { theme?: string | null; title?: string | null }
    | undefined;
  const doc = getPlanDoc("monthly", pick.pick.id);
  return {
    focusId: pick.pick.id,
    theme: head?.theme ?? head?.title ?? null,
    story: doc?.contentMd ?? null,
    periodStart: pick.pick.startedAt.slice(0, 10),
    periodEnd: pick.pick.endDate,
    expired: pick.expired,
  };
}

function weeklySummary(weekOf: string) {
  const row = db
    .select()
    .from(weeklyPlan)
    .where(eq(weeklyPlan.weekOf, weekOf))
    .orderBy(desc(weeklyPlan.createdAt))
    .limit(1)
    .get();
  if (!row) return null;
  const chainCount = db.select().from(weeklyPlanChain).where(eq(weeklyPlanChain.weeklyPlanId, row.id)).all().length;
  return { id: row.id, weekOf: row.weekOf, theme: row.theme, chainCount };
}

export function loadPlanningFacts(referenceDate?: string): PlanningFacts {
  const tz = getConfig<string>("TIMEZONE");
  const date = referenceDate ?? localDate(tz);
  const minutes = localMinutes(tz);
  const targetWeekStart = mondayOf(date);

  // History priors are deliberately era-AGNOSTIC and shallow: themes only
  // (how the user plans), plus the prior week's chains for the carryover
  // check — never completion data.
  const allWeeklies = db.select().from(weeklyPlan).orderBy(desc(weeklyPlan.weekOf), desc(weeklyPlan.createdAt)).all();
  const priorThemes = allWeeklies
    .filter(w => w.weekOf < targetWeekStart)
    .slice(0, 4)
    .map(w => ({ weekOf: w.weekOf, theme: w.theme }));
  const priorWeek = allWeeklies.find(w => w.weekOf < targetWeekStart);
  const priorWeekChains = priorWeek
    ? db
        .select()
        .from(weeklyPlanChain)
        .where(eq(weeklyPlanChain.weeklyPlanId, priorWeek.id))
        .all()
        .map(link => {
          const head = chainHead(link.chainLineageId);
          return head ? { lineageId: link.chainLineageId, trigger: head.trigger, status: head.status } : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
    : [];

  const pick = latestPick();
  const era = loadEraSubstance(pick, date);
  const activeMonthly = activeEra(date);
  const library = activeMonthly
    ? eraChainLibrary(activeMonthly.id)
    : pick && !pick.expired
      ? chainLibrary(pick.groupLineageId)
      : [];
  const tomorrow = addDaysStr(date, 1);
  const planOf = (d: string) => {
    const plan = activePlanFor(d);
    return { date: d, plan: plan ? { id: plan.id, theme: plan.theme } : null };
  };

  return {
    now: {
      date,
      time: minToHhmm(minutes),
      minutes,
      timezone: tz,
      dayOfWeek: new Date(`${date}T00:00:00Z`).getUTCDay(),
    },
    era,
    weekly: { targetWeekStart, plan: weeklySummary(targetWeekStart), priorThemes, priorWeekChains },
    daily: {
      today: planOf(date),
      tomorrow: planOf(tomorrow),
      priorThemes: recentDailyPlans(5).map(p => ({ date: p.date, theme: p.theme })),
    },
    chains: {
      active: library.filter(c => c.status === "active").length,
      draft: library.filter(c => c.status === "draft").length,
      retired: library.filter(c => c.status === "retired").length,
    },
  };
}

// ── Interpretation (pure) ──────────────────────────────────────────────────

function readClock(now: PlanningFacts["now"]): Interpretation["energy"] {
  const { minutes } = now;
  if (minutes < ORACLE_CLOCK.afterMidnightEndMin)
    return { lateness: "after-midnight", note: "It's after midnight — be as kind and quick as possible." };
  if (minutes >= ORACLE_CLOCK.veryLateMin)
    return {
      lateness: "very-late",
      note: `Planning at ${minToHhmm(minutes)}: low energy likely — keep this one short and kind.`,
    };
  if (minutes >= ORACLE_CLOCK.lateMin) return { lateness: "late", note: "Getting late — favor the floor." };
  return { lateness: "none", note: null };
}

export function parseIntent(userRequest?: string): Horizon | null {
  const text = (userRequest ?? "").toLowerCase();
  if (/\bmonth|era\b/.test(text)) return "monthly";
  if (/\bweek/.test(text)) return "weekly";
  if (/\btomorrow\b|\btoday\b|\bdaily\b|\bday\b/.test(text)) return "daily";
  return null;
}

function assessSubstance(facts: PlanningFacts): Interpretation["parentSubstance"] {
  const monthly: Substance = !facts.era || facts.era.expired
    ? "absent"
    : !facts.era.story || facts.era.story.length < THIN_STORY_CHARS
      ? "thin"
      : "substantial";
  const weekly: Substance = !facts.weekly.plan ? "absent" : facts.weekly.plan.chainCount === 0 ? "thin" : "substantial";
  return { monthly, weekly };
}

export function resolveDailyTarget(facts: PlanningFacts, lateness: Lateness): Interpretation["dailyTarget"] {
  // After midnight "today" is ambiguous by definition — target today's date
  // and let the ambiguity carry the question.
  if (lateness === "after-midnight") return { date: facts.now.date, label: "today" };
  if (facts.now.minutes >= ORACLE_CLOCK.eveningCutoverMin)
    return { date: facts.daily.tomorrow.date, label: "tomorrow" };
  if (!facts.daily.today.plan) return { date: facts.now.date, label: "today" };
  return { date: facts.daily.tomorrow.date, label: "tomorrow" };
}

function friendlyDate(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${dateStr}T12:00:00Z`),
  );
}

function weekRange(weekStart: string): string {
  const end = addDaysStr(weekStart, 6);
  const s = friendlyDate(weekStart);
  const e = friendlyDate(end);
  const sameMonth = weekStart.slice(0, 7) === end.slice(0, 7);
  return sameMonth ? `${s}–${e.split(" ")[1]}` : `${s} – ${e}`;
}

export function interpretPlanningState(facts: PlanningFacts, userRequest?: string): Interpretation {
  const parentSubstance = assessSubstance(facts);
  const energy = readClock(facts.now);
  const intent = parseIntent(userRequest);
  const dailyTarget = resolveDailyTarget(facts, energy.lateness);
  const candidates: CandidateFlow[] = [];
  const ambiguities: Ambiguity[] = [];
  const conflicts: string[] = [];
  let blockedBy: Interpretation["blockedBy"] = null;

  if (facts.chains.active >= 5) {
    conflicts.push(
      "chain library sits at its global 5-active cap while the target zone model allows 3 per zone (9) — surfacing, not resolving; the caps reconcile in the weekly rebuild",
    );
  }
  if (energy.lateness === "after-midnight") {
    ambiguities.push({
      kind: "today-vs-tomorrow",
      question: "It's past midnight — are we closing out today or planning the day ahead?",
    });
  }

  const noEra = parentSubstance.monthly === "absent";
  if (noEra) {
    // Refuse-vs-degrade (TARGET §7): absent parent → everything routes
    // forward to monthly-create, warmly. Never an error, never a dead end.
    candidates.push({
      horizon: "monthly",
      operation: "create",
      targetPeriod: "next-era",
      reason: facts.era?.expired ? "the era ended — the next one is unmade" : "no monthly era exists",
      rank: 1,
    });
    if (intent === "weekly" || intent === "daily") blockedBy = { horizon: intent, missingParent: "monthly" };
  } else if (!facts.weekly.plan) {
    candidates.push({
      horizon: "weekly",
      operation: "create",
      targetPeriod: facts.weekly.targetWeekStart,
      reason:
        parentSubstance.monthly === "thin"
          ? "this week has no plan — and the era is floor-thin, so this session digs deeper on story and priorities"
          : "this week has no plan yet",
      rank: 1,
    });
    if (intent === "daily") blockedBy = { horizon: "daily", missingParent: "weekly" };
    if (intent === "monthly")
      candidates.unshift({
        horizon: "monthly",
        operation: "update",
        targetPeriod: facts.era!.focusId,
        reason: "you asked about the era",
        rank: 0,
      });
  } else {
    const targetPlan = dailyTarget.label === "today" ? facts.daily.today.plan : facts.daily.tomorrow.plan;
    if (!targetPlan) {
      candidates.push({
        horizon: "daily",
        operation: "create",
        targetPeriod: dailyTarget.date,
        reason:
          parentSubstance.weekly === "thin"
            ? `no plan for ${dailyTarget.label} — the week is theme-only, so this one takes a bit more building`
            : `no plan for ${dailyTarget.label} yet`,
        rank: 1,
      });
    } else {
      ambiguities.push({
        kind: "update-vs-fresh",
        question: `A plan for ${dailyTarget.label}${targetPlan.theme ? ` ("${targetPlan.theme}")` : ""} already exists — revise it, or leave it alone?`,
      });
      candidates.push(
        {
          horizon: "daily",
          operation: "update",
          targetPeriod: dailyTarget.date,
          reason: `${dailyTarget.label} already has a plan`,
          rank: 1,
        },
        {
          horizon: "weekly",
          operation: "update",
          targetPeriod: facts.weekly.targetWeekStart,
          reason: "the week is live and revisable",
          rank: 2,
        },
        {
          horizon: "monthly",
          operation: "update",
          targetPeriod: facts.era!.focusId,
          reason: "the era accretes promises anytime",
          rank: 3,
        },
      );
    }
    if (intent && candidates[0] && intent !== candidates[0].horizon) {
      const match = candidates.find(c => c.horizon === intent);
      if (match) match.rank = 0;
      else
        candidates.unshift({
          horizon: intent,
          operation: "update",
          targetPeriod:
            intent === "monthly" ? facts.era!.focusId : intent === "weekly" ? facts.weekly.targetWeekStart : dailyTarget.date,
          reason: `you asked about the ${intent === "monthly" ? "era" : intent.replace("ly", "")}`,
          rank: 0,
        });
      candidates.sort((a, b) => a.rank - b.rank);
    }
  }

  const openingMove = buildOpeningMove({ facts, parentSubstance, candidates, ambiguities, energy, dailyTarget, blockedBy });
  return { facts, parentSubstance, candidates, ambiguities, blockedBy, energy, openingMove, conflicts, dailyTarget };
}

function buildOpeningMove(args: {
  facts: PlanningFacts;
  parentSubstance: Interpretation["parentSubstance"];
  candidates: CandidateFlow[];
  ambiguities: Ambiguity[];
  energy: Interpretation["energy"];
  dailyTarget: Interpretation["dailyTarget"];
  blockedBy: Interpretation["blockedBy"];
}): Interpretation["openingMove"] {
  const { facts, parentSubstance, candidates, ambiguities, dailyTarget } = args;
  const top = candidates[0];

  if (parentSubstance.monthly === "absent") {
    const opener = facts.era?.expired
      ? `The era${facts.era.theme ? ` "${facts.era.theme}"` : ""} closed${facts.era.periodEnd ? ` ${friendlyDate(facts.era.periodEnd)}` : ""} — the next one is unmade, and that's the thing to build first. Want to?`
      : "There's no monthly era right now — that's the first thing to make. Want to?";
    return {
      kind: "parent-route",
      lines: [opener, "Rant at what the next stretch is for — theme and story are enough to start; the rest accretes."],
    };
  }

  if (top?.horizon === "weekly" && top.operation === "create") {
    const lines = [`This week (${weekRange(facts.weekly.targetWeekStart)}) has no plan yet — want to build it?`];
    lines.push(
      facts.weekly.priorWeekChains.length > 0
        ? "We'd start from last week's chains — keep, extend, or retire each — then the theme."
        : "Theme first, then the chains to carry it.",
    );
    if (parentSubstance.monthly === "thin")
      lines.push("The era is still thin, so we'll go a little deeper on what this stretch is for.");
    return { kind: "single-offer", lines };
  }

  if (top?.horizon === "daily" && top.operation === "create") {
    // §6.5 SHAPE (the verbatim template lands in the WO-5 playbook): state +
    // cheap version + one optional escalation line, warm throughout.
    return {
      kind: "single-offer",
      lines: [
        `Hey — you don't have a plan for ${dailyTarget.label} yet. Want to make one?`,
        "Cheap version: confirm your usual chains plus a theme — mostly confirming, takes a minute.",
        "And if you've got more in you than that — tell me what's actually on your mind, and the day gets built around it.",
      ],
    };
  }

  // Menu: everything exists (or an update was asked for) — the legal moves,
  // user's call. The update-vs-fresh question rides in front when present.
  const lines: string[] = [];
  const updateAmbiguity = ambiguities.find(a => a.kind === "update-vs-fresh");
  if (updateAmbiguity) lines.push(updateAmbiguity.question);
  const menu: string[] = [];
  for (const c of candidates.slice(0, 3)) {
    if (c.horizon === "daily") menu.push(`${c.operation === "create" ? "plan" : "revise"} ${dailyTarget.label}`);
    if (c.horizon === "weekly") menu.push(`work on the week of ${friendlyDate(facts.weekly.targetWeekStart)}`);
    if (c.horizon === "monthly") menu.push("add to the era");
  }
  lines.push(`Or: ${menu.join(" / ")} — where do you want to go?`);
  return { kind: "menu", lines };
}

// ── Renderer (pure) — BRIEF.skeleton.v1 (PROMPT_PACK §4) ──────────────────

export const BRIEFING_VERSION = "BRIEF.skeleton.v1";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function renderBriefing(interp: Interpretation): string {
  const { facts, parentSubstance, candidates, energy, dailyTarget, conflicts, blockedBy } = interp;
  const lines: string[] = ["# Dream briefing", ""];

  // ## Now — {{weekday}}, {{local_datetime}}. {{lateness_read}}
  lines.push("## Now");
  const nowLine = `${WEEKDAYS[facts.now.dayOfWeek]}, ${friendlyDate(facts.now.date)}, ${facts.now.time}.`;
  lines.push(energy.note ? `${nowLine} ${energy.note}` : nowLine);
  lines.push("");

  // ## Facts — existence/period/status only
  lines.push("## Facts");
  if (!facts.era) lines.push("- No monthly era.");
  else if (facts.era.expired)
    lines.push(
      `- Era${facts.era.theme ? ` "${facts.era.theme}"` : ""} ended${facts.era.periodEnd ? ` ${friendlyDate(facts.era.periodEnd)}` : ""}.`,
    );
  else {
    const period = `${friendlyDate(facts.era.periodStart)} → ${facts.era.periodEnd ? friendlyDate(facts.era.periodEnd) : "open"}`;
    const substanceNote = parentSubstance.monthly === "thin" ? "theme+story only" : "storied";
    lines.push(`- Era${facts.era.theme ? ` "${facts.era.theme}"` : ""} active, ${period} (${substanceNote}).`);
  }
  const wk = facts.weekly.plan;
  lines.push(
    wk
      ? `- Weekly plan exists for ${weekRange(facts.weekly.targetWeekStart)} (${wk.chainCount} chain${wk.chainCount === 1 ? "" : "s"}${wk.theme ? `, theme "${wk.theme}"` : ""}).`
      : `- No weekly plan for ${weekRange(facts.weekly.targetWeekStart)}.`,
  );
  const targetPlan = dailyTarget.label === "today" ? facts.daily.today.plan : facts.daily.tomorrow.plan;
  lines.push(
    targetPlan
      ? `- Daily plan exists for ${dailyTarget.label} (${friendlyDate(dailyTarget.date)})${targetPlan.theme ? `: "${targetPlan.theme}"` : ""}.`
      : `- No daily plan for ${dailyTarget.label} (${friendlyDate(dailyTarget.date)}).`,
  );
  lines.push("");

  // ## Read — inference lines, prefixed Likely: / Quality: / Energy:
  lines.push("## Read (inference, not fact)");
  const top = candidates[0];
  lines.push(top ? `Likely: ${top.horizon}-${top.operation} — ${top.reason}.` : "Likely: nothing pressing.");
  const qualityLine = qualityRead(interp);
  if (qualityLine) lines.push(`Quality: ${qualityLine}`);
  if (energy.note) lines.push(`Energy: ${energy.note}`);
  lines.push("");

  // ## Your opening move
  lines.push("## Your opening move");
  lines.push("Say (adapt, don't recite):");
  for (const line of interp.openingMove.lines) lines.push(line);
  lines.push("");

  // ## Rules for this moment
  lines.push("## Rules for this moment");
  lines.push("Confirm the flow in conversation before beginning. If the user corrects");
  lines.push("date/horizon/operation, follow them.");
  if (blockedBy?.missingParent === "monthly")
    lines.push(
      `INVALID: no active era, so a ${blockedBy.horizon} plan cannot exist yet. Do not work around this. Offer, in one line, to set the era first: "We don't have the big picture yet — want to spend a few minutes on what this stretch is for, then do the week right after?" A thin era (theme + story) is enough to unblock.`,
    );
  if (blockedBy?.missingParent === "weekly")
    lines.push(
      `INVALID: daily plans select from the week's chains, and no weekly exists for ${weekRange(facts.weekly.targetWeekStart)}. Offer the weekly first — floor is theme-only and takes five minutes; a theme-only week means tomorrow just runs existing chains.`,
    );
  for (const conflict of conflicts) lines.push(`Heads up: ${conflict}.`);
  return lines.join("\n");
}

/** The Quality: inference line — parent substance of the likely flow, driving
 * the effort cascade. Facts stay in Facts; this is the read. */
function qualityRead(interp: Interpretation): string | null {
  const top = interp.candidates[0];
  if (!top) return null;
  if (top.horizon === "weekly" && interp.parentSubstance.monthly === "thin")
    return "the era is theme-and-story-thin — plan on the weekly carrying more depth.";
  if (top.horizon === "daily" && interp.parentSubstance.weekly === "thin")
    return "the week is theme-only — tomorrow's plan carries a bit more building than usual.";
  if (top.horizon === "weekly" && interp.parentSubstance.monthly === "substantial")
    return "the era is rich — this weekly can be light.";
  return null;
}

// ── Composition ────────────────────────────────────────────────────────────

export function getPlanningContext(input: { user_request?: string; reference_date?: string }) {
  const facts = loadPlanningFacts(input.reference_date);
  const interp = interpretPlanningState(facts, input.user_request);
  const markdown = renderBriefing(interp);
  return {
    markdown,
    structured: {
      briefingVersion: BRIEFING_VERSION,
      now: facts.now,
      parentSubstance: interp.parentSubstance,
      candidates: interp.candidates,
      ambiguities: interp.ambiguities,
      blockedBy: interp.blockedBy,
      energy: interp.energy,
      openingMove: interp.openingMove,
      conflicts: interp.conflicts,
      dailyTarget: interp.dailyTarget,
    },
  };
}
