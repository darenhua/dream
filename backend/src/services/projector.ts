import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import {
  conversation,
  environmentItem,
  experience,
  experiment,
  experimentGoal,
  extraction,
  extractionLink,
  goal,
  habit,
  proposal,
} from "../db/schema";
import type { TranscriptMessage } from "../domain/parser";
import { getConfig } from "./config";
import { env } from "../lib/env";

// The filesystem is a projection: disposable markdown rendered from SQLite
// before each agent run; wipe-and-rebuild; read-only over the DB.

export function newWorkspace(agentName: string): string {
  const dir = join(env.WORKSPACE_PATH, `${agentName}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir: string, name: string, content: string) {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function transcript(contentJson: string | null, truncateAt: number | null, numbered = false): string {
  if (!contentJson) return "_(transcript unavailable — parse error)_";
  let messages = JSON.parse(contentJson) as TranscriptMessage[];
  // Analysis reads everything strictly before the slug.
  if (truncateAt !== null) messages = messages.slice(0, truncateAt);
  return messages
    .map((m, i) => {
      const speaker = m.role === "user" ? "me" : "claude";
      return numbered ? `**[${i}] ${speaker}:** ${m.content}` : `**${speaker}:** ${m.content}`;
    })
    .join("\n\n");
}

// --- distiller: one conversation, numbered so spans are citable ---

export function projectDistill(conversationId: string, dir: string) {
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) throw new Error(`conversation ${conversationId} not found`);
  write(
    dir,
    "conversation.md",
    `# ${convo.title ?? "(untitled)"}\n\n` +
      `conversation_id: \`${convo.id}\`\ndate: ${convo.sourceUpdatedAt ?? "unknown"}\n\n` +
      transcript(convo.contentJson, convo.slugMessageIdx, true),
  );
}

// --- deriver: trigger extractions + whole corpus + current state ---

type ExtractionRow = typeof extraction.$inferSelect;

function extractionMd(x: ExtractionRow, links: Map<string, string[]>): string {
  const linked = links.get(x.id);
  return (
    `- \`${x.id}\` **${x.kind}**: ${x.text}` + (linked?.length ? `\n  → already feeds: ${linked.join(", ")}` : "")
  );
}

// Markers showing which entities each extraction already feeds — the deriver's
// main convergence signal ("this evidence is already accounted for").
function linkMarkers(): Map<string, string[]> {
  const rows = db
    .select({
      extractionId: extractionLink.extractionId,
      entityType: extractionLink.entityType,
      entityId: extractionLink.entityId,
    })
    .from(extractionLink)
    .all();
  const titles = entityTitles();
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const label = `${r.entityType} "${titles.get(`${r.entityType}:${r.entityId}`) ?? r.entityId}"`;
    (map.get(r.extractionId) ?? map.set(r.extractionId, []).get(r.extractionId)!).push(label);
  }
  return map;
}

function entityTitles(): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of db.select({ id: goal.id, t: goal.title }).from(goal).all()) map.set(`goal:${g.id}`, g.t);
  for (const h of db.select({ id: habit.id, t: habit.title }).from(habit).all()) map.set(`habit:${h.id}`, h.t);
  for (const e of db.select({ id: environmentItem.id, t: environmentItem.title }).from(environmentItem).all())
    map.set(`environment_item:${e.id}`, e.t);
  for (const x of db.select({ id: experience.id, t: experience.title }).from(experience).all())
    map.set(`experience:${x.id}`, x.t);
  for (const ex of db.select({ id: experiment.id, t: experiment.title }).from(experiment).all())
    map.set(`experiment:${ex.id}`, ex.t);
  return map;
}

export function projectDerive(conversationId: string, dir: string) {
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) throw new Error(`conversation ${conversationId} not found`);
  const markers = linkMarkers();

  const trigger = db
    .select()
    .from(extraction)
    .where(eq(extraction.conversationId, conversationId))
    .orderBy(asc(extraction.createdAt))
    .all()
    .filter(x => x.confirmedAt);
  write(
    dir,
    "trigger.md",
    `# The new rant: ${convo.title ?? "(untitled)"} (${(convo.sourceUpdatedAt ?? "").slice(0, 10)})\n\n` +
      `These freshly-confirmed extractions are the occasion for this run.\n\n` +
      (trigger.length ? trigger.map(x => extractionMd(x, markers)).join("\n") : "_(none)_") +
      "\n",
  );

  // The whole confirmed corpus, dated, grouped by conversation — the system's memory.
  const corpus = db
    .select({ x: extraction, convoTitle: conversation.title, convoDate: conversation.sourceUpdatedAt })
    .from(extraction)
    .innerJoin(conversation, eq(extraction.conversationId, conversation.id))
    .where(isNotNull(extraction.confirmedAt))
    .orderBy(asc(conversation.sourceUpdatedAt), asc(extraction.createdAt))
    .all();
  const byConvo = new Map<string, { title: string; date: string; rows: ExtractionRow[] }>();
  for (const row of corpus) {
    const key = row.x.conversationId;
    if (!byConvo.has(key))
      byConvo.set(key, {
        title: row.convoTitle ?? "(untitled)",
        date: (row.convoDate ?? "").slice(0, 10),
        rows: [],
      });
    byConvo.get(key)!.rows.push(row.x);
  }
  const corpusSections = [...byConvo.values()].map(
    c => `## ${c.date} — ${c.title}\n\n${c.rows.map(x => extractionMd(x, markers)).join("\n")}`,
  );
  write(
    dir,
    "corpus.md",
    `# Everything the user has said (confirmed extractions, oldest first)\n\n` +
      (corpusSections.length ? corpusSections.join("\n\n") : "_(corpus is empty)_") +
      "\n",
  );

  write(dir, "state.md", stateMd());
  write(dir, "budget.md", budgetMd());
}

// --- current-state renderings (shared by deriver / prompt generator / schedule agent) ---

export function goalsMd(): string {
  const goals = db
    .select()
    .from(goal)
    .where(inArray(goal.status, ["active", "backlog", "dormant"]))
    .orderBy(asc(goal.sortOrder))
    .all();
  if (!goals.length) return "## Goals\n\n_(none yet)_";
  const attempts = attemptCountMap();
  const lines = goals.map(g => {
    const parts = [
      `### ${g.title} (status: ${g.status}, order: ${g.sortOrder}, attempts: ${attempts.get(g.id) ?? 0}, id: \`${g.id}\`)`,
    ];
    if (g.identityClause) parts.push(`> ${g.identityClause}`);
    if (g.synthesisMd) parts.push(g.synthesisMd);
    return parts.join("\n\n");
  });
  return `## Goals (priority order; attempts = ended experiments that tackled it)\n\n${lines.join("\n\n")}`;
}

function attemptCountMap(): Map<string, number> {
  const rows = db
    .select({ goalId: experimentGoal.goalId, status: experiment.status })
    .from(experimentGoal)
    .innerJoin(experiment, eq(experimentGoal.experimentId, experiment.id))
    .where(inArray(experiment.status, ["succeeded", "failed"]))
    .all();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.goalId, (map.get(r.goalId) ?? 0) + 1);
  return map;
}

export function habitsMd(): string {
  const rows = db.select().from(habit).where(inArray(habit.status, ["established", "building"])).all();
  if (!rows.length) return "## Habits\n\n_(none yet)_";
  const lines = rows.map(
    h =>
      `- ${h.title} (${h.status}${h.valence === "bad" ? ", bad" : ""}${h.preferredTime ? `, ~${h.preferredTime}` : ""}, id: \`${h.id}\`)${h.note ? ` — ${h.note}` : ""}`,
  );
  return `## Habits (anchors for new behavior)\n\n${lines.join("\n")}`;
}

export function environmentMd(): string {
  const rows = db.select().from(environmentItem).where(eq(environmentItem.status, "active")).all();
  if (!rows.length) return "## Environment\n\n_(none yet)_";
  const lines = rows.map(
    e => `- ${e.title} (${e.subKind}, id: \`${e.id}\`)${e.note ? ` — ${e.note}` : ""}`,
  );
  return `## Environment\n\n${lines.join("\n")}`;
}

export function experiencesMd(): string {
  const rows = db.select().from(experience).orderBy(asc(experience.createdAt)).all();
  if (!rows.length) return "## Experiences\n\n_(none yet)_";
  const lines = rows.map(
    e =>
      `- ${e.title} (${e.state}${e.state === "had" && e.hadAt ? ` ${e.hadAt.slice(0, 10)}` : ""}, id: \`${e.id}\`)${e.note ? ` — ${e.note}` : ""}`,
  );
  return `## Experiences (append-only)\n\n${lines.join("\n")}`;
}

export function experimentsMd(): string {
  const rows = db.select().from(experiment).orderBy(desc(experiment.createdAt)).all();
  const queue = rows.filter(e => e.status === "queued" || e.status === "scheduling");
  const running = rows.find(e => e.status === "running");
  const ended = rows.filter(e => e.status === "succeeded" || e.status === "failed");
  const parts = ["## Experiments"];
  parts.push(
    running
      ? `**Running:** ${running.title} (since ${running.startedAt?.slice(0, 10) ?? "?"}, id: \`${running.id}\`)\n\n${running.hypothesisMd ?? ""}`
      : "**Running:** none — fallow season is a first-class mode",
  );
  parts.push(
    `**Queue:**\n${queue.length ? queue.map(e => `- ${e.title} (id: \`${e.id}\`)`).join("\n") : "_(empty)_"}`,
  );
  parts.push(
    `**History (ended, with outcome notes):**\n${
      ended.length
        ? ended
            .map(
              e =>
                `- **${e.title}** (${e.status}, ended ${e.endedAt?.slice(0, 10) ?? "?"})${e.outcomeMd ? ` — ${e.outcomeMd}` : ""}`,
            )
            .join("\n")
        : "_(none yet)_"
    }`,
  );
  return parts.join("\n\n");
}

export function stateMd(): string {
  return (
    `# Current state\n\n` +
    [goalsMd(), habitsMd(), environmentMd(), experiencesMd(), experimentsMd()].join("\n\n") +
    "\n"
  );
}

export function budgetMd(): string {
  const daysSince = daysSinceLastVisit();
  return (
    `# Attention budget\n\n` +
    `- MAX_ACTIVE_GOALS: ${getConfig<number>("MAX_ACTIVE_GOALS")}\n` +
    `- MAX_PROPOSALS_PER_DERIVE: ${getConfig<number>("MAX_PROPOSALS_PER_DERIVE")}\n` +
    `- days_since_last_visit: ${daysSince ?? "never visited"}\n`
  );
}

export function daysSinceLastVisit(): number | null {
  const lastVisit = getConfig<string | null>("LAST_VISIT_AT");
  return lastVisit ? Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86_400_000) : null;
}

// --- prompt generator: full state, for the paste-into-Claude-app prompt ---

export function projectPromptGenerator(dir: string, freeTimeReport: string) {
  write(dir, "state.md", stateMd());
  write(dir, "budget.md", budgetMd());
  write(dir, "free-time.md", freeTimeReport);
  write(
    dir,
    "marker.md",
    `# Marker slug\n\nThe user marks a conversation for import by typing this on its own message: \`${getConfig<string>("SLUG_MARKER")}\`\n`,
  );
}

// --- writeup: pipeline counts + state, demoted glance bait ---

export function projectWriteup(dir: string, pipelineCounts: { awaitingReview: number; pendingProposals: number }) {
  write(dir, "state.md", stateMd());
  write(dir, "budget.md", budgetMd());
  write(
    dir,
    "today.md",
    `# Awaiting the user\n\n- rants awaiting read-back: ${pipelineCounts.awaitingReview}\n- pending proposals: ${pipelineCounts.pendingProposals}\n`,
  );
}

// --- schedule agent: candidate + its evidence + state + free time ---

export function scheduleContextMd(experimentId: string, freeTimeReport: string): string {
  const exp = db.select().from(experiment).where(eq(experiment.id, experimentId)).get();
  if (!exp) throw new Error(`experiment ${experimentId} not found`);
  const goalIds = db
    .select({ goalId: experimentGoal.goalId })
    .from(experimentGoal)
    .where(eq(experimentGoal.experimentId, experimentId))
    .all()
    .map(r => r.goalId);
  const goals = goalIds.length ? db.select().from(goal).where(inArray(goal.id, goalIds)).all() : [];
  const linkedRows = db
    .select({ extractionId: extractionLink.extractionId })
    .from(extractionLink)
    .where(and(eq(extractionLink.entityType, "experiment"), eq(extractionLink.entityId, experimentId)))
    .all()
    .map(r => r.extractionId);
  const cited = linkedRows.length
    ? db.select().from(extraction).where(inArray(extraction.id, linkedRows)).all()
    : [];

  return [
    `# Candidate experiment: ${exp.title}`,
    `id: \`${exp.id}\`\n\n${exp.hypothesisMd ?? ""}`,
    `## Target goals\n\n${
      goals.length
        ? goals.map(g => `- ${g.title}${g.identityClause ? ` — ${g.identityClause}` : ""} (id: \`${g.id}\`)`).join("\n")
        : "_(none linked)_"
    }`,
    `## The user's own words behind this candidate\n\n${
      cited.length ? cited.map(x => `- (${x.kind}) ${x.text}`).join("\n") : "_(no linked extractions)_"
    }`,
    stateMd(),
    `# Free time\n\n${freeTimeReport}`,
    `# Defaults\n\n- default experiment duration: ${getConfig<number>("EXPERIMENT_DEFAULT_DURATION_DAYS")} days (a convention, not a deadline)`,
  ].join("\n\n---\n\n");
}
