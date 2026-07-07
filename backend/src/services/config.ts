import { eq } from "drizzle-orm";
import { db } from "../db";
import { config } from "../db/schema";
import { emit } from "./events";

const PREAMBLE = `You are a component of a personal growth system for one user. You only propose; a human ratifies everything. Be concrete, brief, kind. Never shame. Prefer fewer, higher-confidence proposals, ordered by importance.`;

const PROMPT_CATEGORIZER = `Read the transcript (content after the categorize marker is out of scope). From categories.md, assign this conversation to 1-3 categories with a one-sentence justification each, grounded in the transcript. If nothing fits, propose exactly one new category (name + description). Also extract explicitly mentioned habits, environment factors, or formative experiences as registry_add items (max 3, kind-tagged). Respond with JSON only, no prose around it: {"categorizations":[{"category_id"?: string, "new_category"?: {"name": string, "description": string}, "justification": string}], "registry_adds":[{"kind": "habit"|"environment"|"experience", "title": string, "note"?: string, "valence"?: "good"|"bad"}]}`;

const PROMPT_DERIVER = `Read state.md (current goals, syntheses, recent approved changes), budget.md, and the rant transcripts in rants/. Propose only changes justified by evidence newer than the last approved change for this category; if none, return {"proposals":[]}. Allowed kinds: goal_create (title, identity_clause "I am becoming someone who...", synthesis_md citing rants), goal_update / synthesis_update (rewrite incorporating new evidence), goal_status (with reason), registry_add, registry_prune (contradicted by recent evidence). Every proposal must include source_conversation_ids: the ids of the rant conversations that justify it (listed in each rant file's header). Respect budget.md: at most the stated max proposals, importance-ordered. Respond with JSON only: {"proposals":[{"kind": string, "title": string, ...kind-specific fields, "source_conversation_ids": string[]}]}`;

const PROMPT_DAILY_WRITEUP = `Read budget.md (days_since_last_visit), today's new evidence titles, pending-proposal count, goals, current experiment. Write exactly 3 sentences: (1) one concrete observation from recent evidence; (2) one identity-framed reflection tied to an active goal; (3) if proposals pend, a "caught this before you forgot it" teaser, else a gentle note on the current experiment. If days_since_last_visit > 3: open warm; never mention counts of missed anything; never imply debt. Respond with the 3 sentences as plain text, nothing else.`;

const PROMPT_EXPERIMENT_PACKAGE = `You are my experiment designer. Below is my full current state: prioritized goals with identity framing, my known habits (anchors for new behavior), my environment, and past experiments with outcomes. First, interview me briefly about my current bandwidth (tiny/normal/lots) and anything relevant this week. Then propose ONE experiment: a cohesive change targeting my top goals, sized to my bandwidth, using up to three levers (a new experience; habit changes; environment changes). Every action must be a when-then implementation intention anchored to an existing habit where possible. If the top goal lacks an obvious lever, prefer the smallest first move — a single positive experience — over an ambitious habit. When I confirm, output ONLY this JSON:
{"title": string, "reasoning_md": string, "goal_ids": string[], "levers_json": {"experience"?: string, "habit_changes"?: string[], "environment_changes"?: string[]}, "actions_json": [{"when": string, "then": string}], "bandwidth": "tiny"|"normal"|"lots"}

---

[STATE]`;

// §7.12 — the attention budget and prompts live here, visible and editable.
export const CONFIG_DEFAULTS: Record<string, unknown> = {
  MAX_ACTIVE_GOALS: 5,
  MAX_PROPOSALS_PER_DERIVE: 7,
  TOP_K_RANTS: 10,
  SLUG_CATEGORIZE: "#DREAM-CATEGORIZE",
  MODEL: "sonnet",
  LAST_VISIT_AT: null,
  "PROMPT.preamble": PREAMBLE,
  "PROMPT.categorizer": PROMPT_CATEGORIZER,
  "PROMPT.deriver": PROMPT_DERIVER,
  "PROMPT.daily_writeup": PROMPT_DAILY_WRITEUP,
  "PROMPT.experiment_package": PROMPT_EXPERIMENT_PACKAGE,
};

export function getConfig<T>(key: string): T {
  const row = db.select().from(config).where(eq(config.key, key)).get();
  if (row) return JSON.parse(row.value) as T;
  if (key in CONFIG_DEFAULTS) return CONFIG_DEFAULTS[key] as T;
  throw new Error(`unknown config key: ${key}`);
}

export function setConfig(key: string, value: unknown) {
  db.insert(config)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: config.key, set: { value: JSON.stringify(value) } })
    .run();
  emit("config", key, "config_set", { key });
}

export function getAllConfig(): Record<string, unknown> {
  const rows = db.select().from(config).all();
  const out: Record<string, unknown> = { ...CONFIG_DEFAULTS };
  for (const row of rows) out[row.key] = JSON.parse(row.value);
  return out;
}

// Fills missing keys only, unless overwrite — so re-seeding never clobbers tuned budgets/prompts.
export function seedConfig(overwrite = false) {
  const existing = new Set(db.select({ key: config.key }).from(config).all().map(r => r.key));
  let seeded = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (!overwrite && existing.has(key)) continue;
    db.insert(config)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({ target: config.key, set: { value: JSON.stringify(value) } })
      .run();
    seeded++;
  }
  emit("config", null, "config_seeded", { seeded, overwrite });
  return { seeded, overwrite };
}
