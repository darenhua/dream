import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  collaborationWorkspace,
  companionBranchDraft,
  draftChangeSet,
  environmentItem,
  experience,
  experiment,
  goal,
  habit,
  project,
  proposal,
} from "../db/schema";
import { organizedFeed } from "./organized";

/** Bump only when the persisted snapshot contract changes incompatibly. */
export const WORKSPACE_INDEX_VERSION = 1;

const MAX_PER_CATEGORY = 200;
const MAX_MATCHES_IN_MARKDOWN = 40;
const MAX_CATALOG_PER_CATEGORY = 50;
const MAX_SUMMARY_CHARS = 700;

export type WorkspaceIndexReferenceType =
  | "approved_proposal"
  | "raw_goal"
  | "raw_habit"
  | "raw_environment"
  | "raw_experience"
  | "raw_project"
  | "raw_candidate"
  | "organized_goal"
  | "organized_habit"
  | "organized_environment"
  | "experiment_group";

export type WorkspaceIndexReference = {
  referenceType: WorkspaceIndexReferenceType;
  id: string;
  title: string;
  summary: string | null;
  category: "approved_proposals" | "raw" | "organized" | "candidates";
  provenanceHandles: string[];
};

export type WorkspaceIndexManifest = {
  indexVersion: number;
  workspaceId: string;
  mode: string;
  userSeedMd: string;
  generatedAt: string;
  seedTerms: string[];
  queryStrategy: "case-insensitive token match over bounded accepted/raw/organized summaries";
  sourceCounts: Record<string, number>;
  matchedReferenceKeys: string[];
  referenceCount: number;
};

export type WorkspaceIndexSnapshot = {
  manifest: WorkspaceIndexManifest;
  references: WorkspaceIndexReference[];
};

export type WorkspaceIndexPersistencePayload = {
  indexVersion: number;
  markdownIndex: string;
  referenceManifestJson: string;
  sourceSnapshotJson: string;
  generatedAt: string;
};

export type WorkspaceIndexBuild = {
  markdown: string;
  manifest: WorkspaceIndexManifest;
  snapshot: WorkspaceIndexSnapshot;
  persistence: WorkspaceIndexPersistencePayload;
};

function compact(value: unknown, max = MAX_SUMMARY_CHARS): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function payloadSummary(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const direct = payload.title ?? payload.reason ?? payload.note ?? payload.synthesis_md ?? payload.hypothesis_md;
    return compact(direct ?? payload);
  } catch {
    return compact(payloadJson);
  }
}

function proposalTitle(kind: string, payloadJson: string) {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const title = payload.title ?? payload.reason ?? payload.goal_title;
    return typeof title === "string" && title.trim() ? title.trim() : `approved ${kind}`;
  } catch {
    return `approved ${kind}`;
  }
}

function extractionHandles(payloadJson: string) {
  try {
    const payload = JSON.parse(payloadJson) as { extraction_ids?: unknown };
    return Array.isArray(payload.extraction_ids)
      ? payload.extraction_ids.filter((id): id is string => typeof id === "string").map(id => `extraction:${id}`)
      : [];
  } catch {
    return [];
  }
}

function seedTerms(seed: string) {
  const stop = new Set(["about", "after", "around", "because", "being", "from", "have", "idea", "into", "that", "this", "want", "with", "would"]);
  return [...new Set(seed.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g)?.filter(term => !stop.has(term)) ?? [])].slice(0, 12);
}

function referenceKey(reference: Pick<WorkspaceIndexReference, "referenceType" | "id">) {
  return `${reference.referenceType}:${reference.id}`;
}

function haystack(reference: WorkspaceIndexReference) {
  return `${reference.title}\n${reference.summary ?? ""}\n${reference.provenanceHandles.join("\n")}`.toLowerCase();
}

function matchesTerms(reference: WorkspaceIndexReference, terms: string[]) {
  if (!terms.length) return false;
  const text = haystack(reference);
  return terms.some(term => text.includes(term));
}

function renderReference(reference: WorkspaceIndexReference) {
  const summary = reference.summary ? ` — ${reference.summary}` : "";
  return `- [${reference.referenceType}] ${reference.title} (${reference.id})${summary}`;
}

function categoryMarkdown(name: string, references: WorkspaceIndexReference[]) {
  if (!references.length) return `### ${name}\n\n_No indexed records._`;
  return `### ${name}\n\n${references.slice(0, MAX_CATALOG_PER_CATEGORY).map(renderReference).join("\n")}`;
}

/**
 * Build the immutable data that will be stored when a dashboard code is
 * redeemed. This deliberately performs no persistence: the caller controls
 * the transaction/boundary and can prove the index itself has no domain write.
 */
export function buildWorkspaceIndex(workspaceId: string): WorkspaceIndexBuild {
  const workspace = db.select().from(collaborationWorkspace).where(eq(collaborationWorkspace.id, workspaceId)).get();
  if (!workspace) throw new Error("workspace not found");

  const generatedAt = new Date().toISOString();
  const references: WorkspaceIndexReference[] = [];
  const approved = db
    .select()
    .from(proposal)
    .where(eq(proposal.status, "approved"))
    .orderBy(desc(proposal.resolvedAt), desc(proposal.createdAt))
    .limit(MAX_PER_CATEGORY)
    .all();
  for (const row of approved) {
    references.push({
      referenceType: "approved_proposal",
      id: row.id,
      title: proposalTitle(row.kind, row.payloadJson),
      summary: payloadSummary(row.payloadJson),
      category: "approved_proposals",
      provenanceHandles: [`proposal:${row.id}`, ...extractionHandles(row.payloadJson)],
    });
  }

  const rawGoals = db.select().from(goal).orderBy(desc(goal.updatedAt)).limit(MAX_PER_CATEGORY).all();
  for (const row of rawGoals) {
    references.push({
      referenceType: "raw_goal",
      id: row.id,
      title: row.title,
      summary: compact(row.synthesisMd ?? row.identityClause),
      category: "raw",
      provenanceHandles: [`extraction_link:goal:${row.id}`],
    });
  }
  const rawHabits = db.select().from(habit).orderBy(desc(habit.updatedAt)).limit(MAX_PER_CATEGORY).all();
  for (const row of rawHabits) {
    references.push({
      referenceType: "raw_habit",
      id: row.id,
      title: row.title,
      summary: compact(row.note),
      category: "raw",
      provenanceHandles: [`extraction_link:habit:${row.id}`],
    });
  }
  const rawEnvironment = db.select().from(environmentItem).orderBy(desc(environmentItem.updatedAt)).limit(MAX_PER_CATEGORY).all();
  for (const row of rawEnvironment) {
    references.push({
      referenceType: "raw_environment",
      id: row.id,
      title: row.title,
      summary: compact(row.note),
      category: "raw",
      provenanceHandles: [`extraction_link:environment_item:${row.id}`],
    });
  }
  const rawExperiences = db.select().from(experience).orderBy(desc(experience.updatedAt)).limit(MAX_PER_CATEGORY).all();
  for (const row of rawExperiences) {
    references.push({
      referenceType: "raw_experience",
      id: row.id,
      title: row.title,
      summary: compact(row.note),
      category: "raw",
      provenanceHandles: [`extraction_link:experience:${row.id}`],
    });
  }
  const rawProjects = db.select().from(project).orderBy(desc(project.updatedAt)).limit(MAX_PER_CATEGORY).all();
  for (const row of rawProjects) {
    references.push({
      referenceType: "raw_project",
      id: row.id,
      title: row.title,
      summary: compact(row.note),
      category: "raw",
      provenanceHandles: [`project_source:${row.id}`, `extraction_link:project:${row.id}`],
    });
  }
  const candidates = db
    .select()
    .from(experiment)
    .where(eq(experiment.kind, "candidate"))
    .orderBy(desc(experiment.updatedAt))
    .limit(MAX_PER_CATEGORY)
    .all();
  for (const row of candidates) {
    references.push({
      referenceType: "raw_candidate",
      id: row.id,
      title: row.title,
      summary: compact(row.hypothesisMd ?? row.proposedChangesJson),
      category: "candidates",
      provenanceHandles: [`extraction_link:experiment:${row.id}`],
    });
  }

  const feed = organizedFeed();
  for (const row of feed.goals.slice(0, MAX_PER_CATEGORY)) {
    references.push({
      referenceType: "organized_goal",
      id: row.id,
      title: row.title,
      summary: compact(row.synthesisMd ?? row.identityClause),
      category: "organized",
      provenanceHandles: [`organized_goal_source:${row.id}`],
    });
  }
  for (const row of feed.habits.slice(0, MAX_PER_CATEGORY)) {
    references.push({
      referenceType: "organized_habit",
      id: row.id,
      title: row.title,
      summary: compact(row.synthesisMd ?? row.note),
      category: "organized",
      provenanceHandles: [`organized_registry_source:habit:${row.id}`],
    });
  }
  for (const row of feed.environment.slice(0, MAX_PER_CATEGORY)) {
    references.push({
      referenceType: "organized_environment",
      id: row.id,
      title: row.title,
      summary: compact(row.synthesisMd ?? row.note),
      category: "organized",
      provenanceHandles: [`organized_registry_source:environment:${row.id}`],
    });
  }
  for (const row of feed.groups.slice(0, MAX_PER_CATEGORY)) {
    references.push({
      referenceType: "experiment_group",
      id: row.id,
      title: row.title,
      summary: compact(row.motivationMd),
      category: "organized",
      provenanceHandles: [`experiment_group_source:${row.id}`, `experiment_group_context:${row.id}`],
    });
  }

  const terms = seedTerms(workspace.userSeedMd ?? "");
  const matched = references.filter(reference => matchesTerms(reference, terms));
  const sourceCounts = references.reduce<Record<string, number>>((counts, reference) => {
    counts[reference.referenceType] = (counts[reference.referenceType] ?? 0) + 1;
    return counts;
  }, {});
  const manifest: WorkspaceIndexManifest = {
    indexVersion: WORKSPACE_INDEX_VERSION,
    workspaceId,
    mode: workspace.mode,
    userSeedMd: workspace.userSeedMd ?? "",
    generatedAt,
    seedTerms: terms,
    queryStrategy: "case-insensitive token match over bounded accepted/raw/organized summaries",
    sourceCounts,
    matchedReferenceKeys: matched.map(referenceKey),
    referenceCount: references.length,
  };
  const snapshot: WorkspaceIndexSnapshot = { manifest, references };
  const byCategory = (category: WorkspaceIndexReference["category"]) => references.filter(reference => reference.category === category);
  const markdown = [
    "# Dream Coach workspace index",
    "",
    `**Mode:** \`${workspace.mode}\``,
    `**User-named direction:** ${workspace.userSeedMd ?? "(none)"}`,
    `**Generated:** ${generatedAt}`,
    "",
    "## How to use this index",
    "",
    "This is a bounded orientation map, not a decision. Start with the strong matches, then use the indexed search/detail/provenance tools for current evidence. Do not infer that a listed record is a user-approved direction or an allowed write.",
    "",
    "## Query/filter provenance",
    "",
    `Seed terms: ${terms.length ? terms.map(term => `\`${term}\``).join(", ") : "none (use search_workspace_index)"}.`,
    `Matched ${matched.length} of ${references.length} indexed records using a case-insensitive token match over title, summary, and provenance handles.`,
    "",
    "## Strong starting matches",
    "",
    ...(matched.length ? matched.slice(0, MAX_MATCHES_IN_MARKDOWN).map(renderReference) : ["_No automatic match. Ask the user or search the catalog; absence of a match is not absence of relevant context._"]),
    "",
    "## Catalog",
    "",
    categoryMarkdown("Approved proposal-derived material", byCategory("approved_proposals")),
    "",
    categoryMarkdown("Raw goals, habits, environment, experiences, and projects", byCategory("raw")),
    "",
    categoryMarkdown("Raw experiment candidates", byCategory("candidates")),
    "",
    categoryMarkdown("Existing organized layer", byCategory("organized")),
  ].join("\n");
  return {
    markdown,
    manifest,
    snapshot,
    persistence: {
      indexVersion: WORKSPACE_INDEX_VERSION,
      markdownIndex: markdown,
      referenceManifestJson: JSON.stringify(manifest),
      sourceSnapshotJson: JSON.stringify(snapshot),
      generatedAt,
    },
  };
}

const MAX_OPEN_LOOPS = 20;

function headlineOf(summaryMd: string): string {
  return compact(summaryMd.split("\n")[0]?.replace(/^#+\s*/, ""), 120) ?? "untitled draft";
}

/** Where a listed draft's ball actually sits, so the agent knows whether it is
 * waiting on the dashboard or back on itself for revision. */
function loopDisposition(status: string): string {
  switch (status) {
    case "ready_for_review":
      return "awaiting dashboard review";
    case "drafting":
      return "in revision (may carry dashboard feedback)";
    default:
      return status;
  }
}

/**
 * Cross-conversation state hygiene, computed at READ time (never baked into the
 * immutable snapshot): other nonterminal creator workspaces and pending
 * companion inbox drafts, so a blank agent can acknowledge loose threads ("you
 * never applied X") instead of contradicting them. Read-only awareness — none
 * of these are addressable through this workspace's tools.
 *
 * Single-user deployment: this surfaces every pending companion draft to any
 * creator workspace. That is intentional here (one owner), but it is the reason
 * this section must gain an identity filter before a second companion identity
 * exists — see the identity scoping in companion.ts.
 */
export function openLoopSection(currentWorkspaceId: string): string {
  const lines: string[] = [];
  const otherWorkspaces = db
    .select()
    .from(collaborationWorkspace)
    .where(inArray(collaborationWorkspace.status, ["open", "draft_ready"]))
    .all()
    .filter(row => row.id !== currentWorkspaceId);
  for (const row of otherWorkspaces) {
    if (lines.length >= MAX_OPEN_LOOPS) break;
    const draft = db
      .select({ status: draftChangeSet.status, summaryMd: draftChangeSet.summaryMd })
      .from(draftChangeSet)
      .where(eq(draftChangeSet.workspaceId, row.id))
      .orderBy(desc(draftChangeSet.updatedAt))
      .get();
    const seed = compact(row.userSeedMd, 160) ?? "(none)";
    const detail = draft ? `draft "${headlineOf(draft.summaryMd)}" — ${loopDisposition(draft.status)}` : "no draft yet";
    lines.push(`- Open \`${row.mode}\` workspace — seed: "${seed}" (${detail}).`);
  }
  const pendingBranches = db
    .select({ status: companionBranchDraft.status, summaryMd: companionBranchDraft.summaryMd })
    .from(companionBranchDraft)
    .where(inArray(companionBranchDraft.status, ["drafting", "ready_for_review"]))
    .all();
  for (const row of pendingBranches) {
    if (lines.length >= MAX_OPEN_LOOPS) break;
    lines.push(`- Companion branch draft "${headlineOf(row.summaryMd)}" (${loopDisposition(row.status)}; in the dashboard inbox — not a group yet).`);
  }
  const total = otherWorkspaces.length + pendingBranches.length;
  const overflow = total > lines.length ? [`- …and ${total - lines.length} more open loops (see the dashboard).`] : [];
  const body = lines.length ? [...lines, ...overflow] : ["_None: no other pending workspaces or inbox drafts._"];
  return [
    "## Open loops (unapplied work)",
    "",
    "Computed live at read time. These exist but are NOT domain state until the dashboard applies them. If one overlaps this conversation, tell the user instead of silently duplicating or contradicting it.",
    "",
    ...body,
  ].join("\n");
}

export function parseWorkspaceIndexSnapshot(value: string): WorkspaceIndexSnapshot {
  const parsed = JSON.parse(value) as Partial<WorkspaceIndexSnapshot>;
  if (!parsed.manifest || !Array.isArray(parsed.references)) throw new Error("workspace index snapshot is invalid");
  return parsed as WorkspaceIndexSnapshot;
}

export function searchWorkspaceIndexSnapshot(
  snapshot: WorkspaceIndexSnapshot,
  query: string,
  options: { cursor?: string; limit?: number } = {},
) {
  const terms = seedTerms(query);
  const offset = options.cursor && /^\d+$/.test(options.cursor) ? Number(options.cursor) : 0;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const matches = snapshot.references.filter(reference => matchesTerms(reference, terms));
  const page = matches.slice(offset, offset + limit);
  return {
    matches: page,
    nextCursor: offset + page.length < matches.length ? String(offset + page.length) : null,
    totalMatches: matches.length,
  };
}

export function findWorkspaceIndexReference(
  snapshot: WorkspaceIndexSnapshot,
  referenceType: string,
  entityId: string,
) {
  return snapshot.references.find(reference => reference.referenceType === referenceType && reference.id === entityId) ?? null;
}
