import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import {
  category,
  conversation,
  dailyWriteup,
  experiment,
  goal,
  proposal,
  rantLink,
  registryItem,
} from "../db/schema";
import type { TranscriptMessage } from "../domain/parser";
import { getConfig } from "./config";
import { env } from "../lib/env";

// §8.4 / A4 — the filesystem is a projection: disposable markdown rendered from
// SQLite before each agent run; wipe-and-rebuild; read-only over the DB.

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

function transcript(contentJson: string | null, truncateAt: number | null): string {
  if (!contentJson) return "_(transcript unavailable — parse error)_";
  let messages = JSON.parse(contentJson) as TranscriptMessage[];
  // Analysis reads everything strictly before the slug (A5).
  if (truncateAt !== null) messages = messages.slice(0, truncateAt);
  return messages
    .map(m => `**${m.role === "user" ? "me" : "claude"}:** ${m.content}`)
    .join("\n\n");
}

function slugSafe(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

// --- categories.md (shared by conversation + category projections) ---

function categoriesMd(): string {
  const cats = db.select().from(category).where(eq(category.status, "active")).all();
  const lines = cats.map(
    c => `- **${c.name}** (id: \`${c.id}\`)${c.description ? ` — ${c.description}` : ""}`,
  );
  return `# Categories\n\n${lines.length ? lines.join("\n") : "_(no categories yet)_"}\n`;
}

// --- projectConversation — context for the categorizer ---

export function projectConversation(conversationId: string, dir: string) {
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) throw new Error(`conversation ${conversationId} not found`);
  write(
    dir,
    "conversation.md",
    `# ${convo.title ?? "(untitled)"}\n\n` +
      `conversation_id: \`${convo.id}\`\ndate: ${convo.sourceUpdatedAt ?? "unknown"}\n\n` +
      transcript(convo.contentJson, convo.slugMessageIdx),
  );
  write(dir, "categories.md", categoriesMd());
}

// --- projectCategory — context for the deriver ---

export function projectCategory(categoryId: string, dir: string) {
  const cat = db.select().from(category).where(eq(category.id, categoryId)).get();
  if (!cat) throw new Error(`category ${categoryId} not found`);

  const goals = db
    .select()
    .from(goal)
    .where(eq(goal.categoryId, categoryId))
    .orderBy(asc(goal.sortOrder))
    .all();

  const recentApproved = db
    .select()
    .from(proposal)
    .where(and(eq(proposal.scopeKey, `category:${categoryId}`), eq(proposal.status, "approved")))
    .orderBy(desc(proposal.resolvedAt))
    .limit(5)
    .all();

  const goalLines = goals.map(g => {
    const parts = [
      `## ${g.title} (status: ${g.status}, order: ${g.sortOrder}, id: \`${g.id}\`)`,
    ];
    if (g.identityClause) parts.push(`> ${g.identityClause}`);
    if (g.synthesisMd) parts.push(g.synthesisMd);
    return parts.join("\n\n");
  });

  const changeLines = recentApproved.map(p => {
    const payload = JSON.parse(p.payloadJson);
    return `- ${p.resolvedAt}: approved **${p.kind}** — ${payload.title ?? payload.justification ?? ""}`;
  });

  write(
    dir,
    "state.md",
    `# Category: ${cat.name}\n\n${cat.description ?? ""}\n\n` +
      `## Current goals\n\n${goalLines.length ? goalLines.join("\n\n") : "_(none yet)_"}\n\n` +
      `## Recent approved changes\n\n${changeLines.length ? changeLines.join("\n") : "_(none — this may be the first derive)_"}\n` +
      `\nPropose only changes justified by evidence newer than the last approved change above; if none, return {"proposals":[]}.\n`,
  );

  // The working set is every active link: rebalancing keeps ≤K non-pinned,
  // and pinned links legitimately exceed K (amendment 3) — no cap here.
  const rants = db
    .select({ convo: conversation })
    .from(rantLink)
    .innerJoin(conversation, eq(rantLink.conversationId, conversation.id))
    .where(and(eq(rantLink.categoryId, categoryId), eq(rantLink.activeForDerive, true)))
    .orderBy(desc(conversation.sourceUpdatedAt))
    .all();

  rants.forEach(({ convo }, i) => {
    const date = (convo.sourceUpdatedAt ?? "").slice(0, 10);
    write(
      dir,
      join("rants", `${String(i + 1).padStart(3, "0")}-${date}-${slugSafe(convo.title ?? "untitled")}.md`),
      `# ${convo.title ?? "(untitled)"}\n\n` +
        `conversation_id: \`${convo.id}\`\ndate: ${convo.sourceUpdatedAt ?? "unknown"}\n\n` +
        transcript(convo.contentJson, convo.slugMessageIdx),
    );
  });

  write(dir, "budget.md", budgetMd());
}

// --- projectGlobal — context for the writeup + experiment package ---

export function projectGlobal(dir: string) {
  write(dir, "registries.md", registriesMd());
  write(dir, "goals-all.md", goalsAllMd());
  write(dir, "experiment-current.md", experimentCurrentMd());
  write(dir, "experiment-history.md", experimentHistoryMd());
  write(dir, "budget.md", budgetMd());
}

export function registriesMd(): string {
  const items = db.select().from(registryItem).orderBy(asc(registryItem.createdAt)).all();
  const section = (kind: "habit" | "environment" | "experience") => {
    const rows = items.filter(i => i.kind === kind && i.status === "active");
    if (!rows.length) return "_(none)_";
    return rows
      .map(i => `- ${i.title}${i.valence ? ` (${i.valence})` : ""}${i.note ? ` — ${i.note}` : ""}`)
      .join("\n");
  };
  return (
    `# Registries — the current garden\n\n` +
    `## Habits (anchors for implementation intentions)\n\n${section("habit")}\n\n` +
    `## Environment\n\n${section("environment")}\n\n` +
    `## Experiences (append-only)\n\n${section("experience")}\n`
  );
}

export function goalsAllMd(): string {
  const cats = db.select().from(category).all();
  const catName = new Map(cats.map(c => [c.id, c.name]));
  const goals = db
    .select()
    .from(goal)
    .where(inArray(goal.status, ["active", "backlog", "dormant"]))
    .orderBy(asc(goal.status), asc(goal.sortOrder))
    .all();
  if (!goals.length) return "# Goals\n\n_(none yet)_\n";
  const lines = goals.map(g => {
    const parts = [
      `## ${g.title} (status: ${g.status}, order: ${g.sortOrder}, id: \`${g.id}\`)` +
        (g.categoryId ? ` — category: ${catName.get(g.categoryId) ?? "?"}` : ""),
    ];
    if (g.identityClause) parts.push(`> ${g.identityClause}`);
    if (g.synthesisMd) parts.push(g.synthesisMd);
    return parts.join("\n\n");
  });
  return `# Goals (active first, in priority order)\n\n${lines.join("\n\n")}\n`;
}

export function experimentCurrentMd(): string {
  const live = db
    .select()
    .from(experiment)
    .where(inArray(experiment.status, ["committed", "running"]))
    .get();
  if (!live) return "# Current experiment\n\n_(none live — fallow season is a first-class mode)_\n";
  const actions = (JSON.parse(live.actionsJson) as { when: string; then: string }[])
    .map(a => `- when ${a.when}, then ${a.then}`)
    .join("\n");
  const days = live.committedAt
    ? Math.floor((Date.now() - new Date(live.committedAt).getTime()) / 86_400_000)
    : 0;
  return (
    `# Current experiment: ${live.title}\n\n` +
    `status: ${live.status} · day ${days} · bandwidth: ${live.bandwidth}\n\n` +
    `${live.reasoningMd ?? ""}\n\n## Implementation intentions\n\n${actions}\n`
  );
}

export function experimentHistoryMd(): string {
  const past = db
    .select()
    .from(experiment)
    .where(inArray(experiment.status, ["done", "composted"]))
    .orderBy(desc(experiment.endedAt))
    .all();
  if (!past.length) return "# Experiment history\n\n_(none yet)_\n";
  const lines = past.map(
    e =>
      `- **${e.title}** (${e.status}, ended ${e.endedAt?.slice(0, 10) ?? "?"})${e.outcomeMd ? ` — ${e.outcomeMd}` : ""}`,
  );
  return `# Experiment history\n\n${lines.join("\n")}\n`;
}

export function budgetMd(): string {
  const lastVisit = getConfig<string | null>("LAST_VISIT_AT");
  const daysSince = lastVisit
    ? Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86_400_000)
    : null;
  return (
    `# Attention budget\n\n` +
    `- MAX_ACTIVE_GOALS: ${getConfig<number>("MAX_ACTIVE_GOALS")}\n` +
    `- MAX_PROPOSALS_PER_DERIVE: ${getConfig<number>("MAX_PROPOSALS_PER_DERIVE")}\n` +
    `- TOP_K_RANTS: ${getConfig<number>("TOP_K_RANTS")}\n` +
    `- days_since_last_visit: ${daysSince ?? "never visited"}\n`
  );
}

export function daysSinceLastVisit(): number | null {
  const lastVisit = getConfig<string | null>("LAST_VISIT_AT");
  return lastVisit
    ? Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86_400_000)
    : null;
}

// Used by the writeup: evidence since the previous writeup row (amendment 5).
export function recentEvidenceTitles(): string[] {
  const lastWriteup = db
    .select()
    .from(dailyWriteup)
    .orderBy(desc(dailyWriteup.date))
    .limit(2)
    .all();
  // The writeup being (re)generated today may already have a row; window from the one before.
  const since =
    lastWriteup.length > 1
      ? lastWriteup[1]!.createdAt
      : new Date(Date.now() - 86_400_000).toISOString();
  return db
    .select({ title: conversation.title, updatedAt: conversation.updatedAt })
    .from(conversation)
    .orderBy(desc(conversation.updatedAt))
    .limit(50)
    .all()
    .filter(c => c.updatedAt > since)
    .map(c => c.title ?? "(untitled)");
}
