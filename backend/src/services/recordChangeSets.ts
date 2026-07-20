import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { draftChangeSet } from "../db/schema";
import { emit } from "./events";
import {
  LINEAGE_REF_FIELDS,
  RelationSchema,
  VersionedModelSchema,
  createFieldsSchema,
  insertRelation,
  insertVersionRow,
  lineageHead,
  searchModel,
  type VersionedModel,
} from "./records";

// The generalized write membrane (Phase 2). One record_create call produces
// one change set: create ops (a central record + satellites) and link ops.
// Nothing touches a domain table until the dashboard applies the whole set;
// the AI reconciliation pass only annotates verdicts for the human reviewer.

const CreateOpSchema = z
  .object({
    op: z.literal("create"),
    tempId: z.string().trim().min(1).max(100),
    model: VersionedModelSchema,
    role: z.enum(["central", "satellite"]).default("satellite"),
    fields: z.record(z.string(), z.unknown()),
  })
  .strict();

const LinkOpSchema = z
  .object({
    op: z.literal("link"),
    relation: RelationSchema,
    from: z.string().trim().min(1).max(200), // "temp:<tempId>" or a lineage id
    to: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    rank: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const RecordOperationSchema = z.discriminatedUnion("op", [CreateOpSchema, LinkOpSchema]);
export const RecordOperationsSchema = z.array(RecordOperationSchema).min(1).max(200);
export type RecordOperation = z.infer<typeof RecordOperationSchema>;

// Review verdicts, one per create op. Defaults to "new" when the reviewer
// (or the reconciliation agent) says nothing.
export const VerdictSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("new") }),
  z.object({ verdict: z.literal("version_bump"), ofLineageId: z.string().min(1) }),
  z.object({
    verdict: z.literal("remix"),
    parents: z.array(z.object({ model: VersionedModelSchema, versionId: z.string().min(1) })).min(1).max(10),
  }),
  z.object({ verdict: z.literal("link_existing"), lineageId: z.string().min(1) }),
]);
export type Verdict = z.infer<typeof VerdictSchema>;
export const VerdictMapSchema = z.record(z.string(), VerdictSchema);

function validateOperations(raw: unknown): RecordOperation[] {
  const ops = RecordOperationsSchema.parse(raw);
  const centralCount = ops.filter(o => o.op === "create" && o.role === "central").length;
  if (centralCount !== 1) throw new Error("a change set needs exactly one central create");
  const tempIds = new Set<string>();
  for (const op of ops) {
    if (op.op !== "create") continue;
    if (tempIds.has(op.tempId)) throw new Error(`duplicate tempId ${op.tempId}`);
    tempIds.add(op.tempId);
    createFieldsSchema(op.model).parse(op.fields);
  }
  for (const op of ops) {
    if (op.op !== "link") continue;
    for (const ref of [op.from, op.to]) {
      if (ref.startsWith("temp:") && !tempIds.has(ref.slice(5))) {
        throw new Error(`link references unknown ${ref}`);
      }
    }
  }
  return ops;
}

function newMarkerToken(): string {
  return `rc_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function serializeRecordChangeSet(row: typeof draftChangeSet.$inferSelect) {
  return {
    id: row.id,
    summaryMd: row.summaryMd,
    operations: JSON.parse(row.operationsJson) as RecordOperation[],
    audit: row.auditJson ? (JSON.parse(row.auditJson) as Record<string, unknown>) : null,
    reconciliation: row.reconciliationJson ? (JSON.parse(row.reconciliationJson) as ReconciliationReport) : null,
    appliedRecords: row.appliedRecordsJson
      ? (JSON.parse(row.appliedRecordsJson) as Record<string, AppliedRecord>)
      : null,
    markerToken: row.markerToken,
    status: row.status,
    rejectionNote: row.rejectionNote,
    submittedAt: row.submittedAt,
    appliedAt: row.appliedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** MCP entry: save one complete change set and submit it for review. */
export function createRecordChangeSet(input: { summaryMd: string; operations: unknown; auditNote?: string }) {
  const operations = validateOperations(input.operations);
  const row = db
    .insert(draftChangeSet)
    .values({
      summaryMd: input.summaryMd,
      operationsJson: JSON.stringify(operations),
      auditJson: input.auditNote ? JSON.stringify({ note: input.auditNote }) : null,
      markerToken: newMarkerToken(),
      status: "ready_for_review",
      submittedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  emit("draft_change_set", row.id, "record_change_set_submitted", { markerToken: row.markerToken });
  return serializeRecordChangeSet(row);
}

/** Revision after dashboard feedback: replaces the operations of a drafting
 * (returned) change set and resubmits it. Same row, same marker token. */
export function reviseRecordChangeSet(id: string, input: { summaryMd: string; operations: unknown; auditNote?: string }) {
  const row = db.select().from(draftChangeSet).where(eq(draftChangeSet.id, id)).get();
  if (!row || row.workspaceId) throw new Error("record change set not found");
  if (row.status !== "drafting") throw new Error(`change set is ${row.status}, not returned for revision`);
  const operations = validateOperations(input.operations);
  const updated = db
    .update(draftChangeSet)
    .set({
      summaryMd: input.summaryMd,
      operationsJson: JSON.stringify(operations),
      auditJson: input.auditNote ? JSON.stringify({ note: input.auditNote }) : row.auditJson,
      reconciliationJson: null,
      status: "ready_for_review",
      submittedAt: new Date().toISOString(),
    })
    .where(eq(draftChangeSet.id, id))
    .returning()
    .get();
  emit("draft_change_set", id, "record_change_set_resubmitted", {});
  return serializeRecordChangeSet(updated);
}

export function listRecordChangeSets(status?: string) {
  return db
    .select()
    .from(draftChangeSet)
    .where(
      and(
        isNull(draftChangeSet.workspaceId),
        status ? eq(draftChangeSet.status, status as typeof draftChangeSet.$inferSelect.status) : undefined,
      ),
    )
    .orderBy(desc(draftChangeSet.updatedAt))
    .all()
    .map(serializeRecordChangeSet);
}

export function getRecordChangeSet(id: string) {
  const row = db.select().from(draftChangeSet).where(and(eq(draftChangeSet.id, id), isNull(draftChangeSet.workspaceId))).get();
  return row ? serializeRecordChangeSet(row) : null;
}

export function getRecordChangeSetByMarker(markerToken: string) {
  const row = db.select().from(draftChangeSet).where(eq(draftChangeSet.markerToken, markerToken)).get();
  return row ? serializeRecordChangeSet(row) : null;
}

export type AppliedRecord = {
  model: VersionedModel;
  versionId: string;
  lineageId: string;
  verdict: Verdict["verdict"];
  role: "central" | "satellite";
  title: string;
};

/** Dashboard-only apply. verdictOverrides (from the review UI) win over the
 * reconciliation agent's suggestions; anything unspecified is created new. */
export function applyRecordChangeSet(id: string, verdictOverrides?: Record<string, unknown>) {
  const row = db.select().from(draftChangeSet).where(and(eq(draftChangeSet.id, id), isNull(draftChangeSet.workspaceId))).get();
  if (!row) return { ok: false as const, error: "record change set not found" };
  if (row.status !== "ready_for_review") return { ok: false as const, error: `change set is ${row.status}` };

  try {
    const result = db.transaction(() => {
      const ready = db
        .select()
        .from(draftChangeSet)
        .where(and(eq(draftChangeSet.id, id), eq(draftChangeSet.status, "ready_for_review")))
        .get();
      if (!ready) throw new Error("change set is no longer ready for review");
      const operations = validateOperations(JSON.parse(ready.operationsJson));

      const suggested = ready.reconciliationJson
        ? (JSON.parse(ready.reconciliationJson) as ReconciliationReport).verdicts ?? {}
        : {};
      const overrides = verdictOverrides ? VerdictMapSchema.parse(verdictOverrides) : {};
      const verdictFor = (tempId: string): Verdict =>
        (overrides[tempId] as Verdict | undefined) ?? (suggested[tempId] as Verdict | undefined) ?? { verdict: "new" };

      // temp resolution: created (or linked-existing) tempIds → lineage ids
      const resolved = new Map<string, { lineageId: string; versionId: string }>();
      const applied: Record<string, AppliedRecord> = {};

      const resolveRef = (ref: string): string => {
        if (!ref.startsWith("temp:")) return ref;
        const hit = resolved.get(ref.slice(5));
        if (!hit) throw new Error(`unresolved reference ${ref}`);
        return hit.lineageId;
      };

      // create ops may reference each other through lineage-ref fields; loop
      // until stable so order doesn't matter.
      const pending = operations.filter(op => op.op === "create");
      let progressed = true;
      while (pending.length && progressed) {
        progressed = false;
        for (let i = 0; i < pending.length; i++) {
          const op = pending[i]!;
          const refs = Object.entries(op.fields).filter(
            ([key, value]) => LINEAGE_REF_FIELDS.has(key) && typeof value === "string" && value.startsWith("temp:"),
          );
          if (refs.some(([, value]) => !resolved.has((value as string).slice(5)))) continue;

          // re-parse so zod defaults (e.g. habit.origin) reach the insert
          const fields: Record<string, unknown> = createFieldsSchema(op.model).parse(op.fields) as Record<string, unknown>;
          for (const [key, value] of refs) fields[key] = resolveRef(value as string);

          const verdict = verdictFor(op.tempId);
          let outcome: { versionId: string; lineageId: string };
          if (verdict.verdict === "link_existing") {
            const head = lineageHead(op.model, verdict.lineageId);
            if (!head) throw new Error(`link_existing target ${verdict.lineageId} not found for ${op.model}`);
            outcome = { versionId: head.id, lineageId: verdict.lineageId };
          } else if (verdict.verdict === "version_bump") {
            const head = lineageHead(op.model, verdict.ofLineageId);
            if (!head) throw new Error(`version_bump target ${verdict.ofLineageId} not found for ${op.model}`);
            outcome = insertVersionRow({
              model: op.model,
              fields,
              lineage: { lineageId: verdict.ofLineageId, prevVersionId: head.id, version: (head.version ?? 1) + 1 },
            });
          } else if (verdict.verdict === "remix") {
            outcome = insertVersionRow({
              model: op.model,
              fields,
              parents: verdict.parents.map(p => ({ type: p.model, versionId: p.versionId })),
            });
          } else {
            outcome = insertVersionRow({ model: op.model, fields });
          }
          resolved.set(op.tempId, outcome);
          applied[op.tempId] = {
            model: op.model,
            versionId: outcome.versionId,
            lineageId: outcome.lineageId,
            verdict: verdict.verdict,
            role: op.role,
            title: String(op.fields.title ?? ""),
          };
          pending.splice(i, 1);
          i--;
          progressed = true;
        }
      }
      if (pending.length) throw new Error("circular temp references between create operations");

      for (const op of operations) {
        if (op.op !== "link") continue;
        insertRelation(op.relation, resolveRef(op.from), resolveRef(op.to), {
          description: op.description,
          rank: op.rank,
        });
      }

      const updated = db
        .update(draftChangeSet)
        .set({
          status: "applied",
          appliedAt: new Date().toISOString(),
          appliedRecordsJson: JSON.stringify(applied),
        })
        .where(and(eq(draftChangeSet.id, id), eq(draftChangeSet.status, "ready_for_review")))
        .returning()
        .get();
      if (!updated) throw new Error("change set was reviewed by another request");
      return updated;
    });
    emit("draft_change_set", id, "record_change_set_applied", {});
    return { ok: true as const, changeSet: serializeRecordChangeSet(result) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export function rejectRecordChangeSet(id: string, input: { feedback?: string; returnToDrafting?: boolean } = {}) {
  const row = db.select().from(draftChangeSet).where(and(eq(draftChangeSet.id, id), isNull(draftChangeSet.workspaceId))).get();
  if (!row) return null;
  if (row.status !== "ready_for_review") throw new Error(`change set is ${row.status}`);
  const returnToDrafting = Boolean(input.returnToDrafting);
  const updated = db
    .update(draftChangeSet)
    .set({
      status: returnToDrafting ? "drafting" : "rejected",
      rejectionNote: input.feedback ?? null,
      rejectedAt: returnToDrafting ? null : new Date().toISOString(),
    })
    .where(and(eq(draftChangeSet.id, id), eq(draftChangeSet.status, "ready_for_review")))
    .returning()
    .get();
  if (!updated) throw new Error("change set was reviewed by another request");
  emit("draft_change_set", id, returnToDrafting ? "record_change_set_returned" : "record_change_set_rejected", {
    feedback: input.feedback ?? null,
  });
  return serializeRecordChangeSet(updated);
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export type ReconciliationReport = {
  candidates: Record<string, ReturnType<typeof searchModel>>;
  verdicts?: Record<string, Verdict>;
  reasons?: Record<string, string>;
  agentRunId?: string | null;
};

/** Deterministic half: per created row, similar existing lineage heads. */
export function reconciliationCandidates(operations: RecordOperation[]) {
  const candidates: ReconciliationReport["candidates"] = {};
  for (const op of operations) {
    if (op.op !== "create") continue;
    const query = `${op.fields.title ?? ""} ${op.fields.description ?? ""}`;
    candidates[op.tempId] = searchModel(op.model, query, 5);
  }
  return candidates;
}

const ReconcilerOutput = z.object({
  verdicts: z.array(
    z.object({
      temp_id: z.string(),
      verdict: z.enum(["new", "version_bump", "remix", "link_existing"]),
      of_lineage_id: z.string().nullable().optional(),
      reason: z.string().max(500),
    }),
  ),
});

type StructuredRunner = (
  agentName: "record_reconciler",
  workspacePath: string,
  schema: typeof ReconcilerOutput,
  opts: { trigger: "daily" | "manual"; hints?: string },
) => Promise<{ runId: string | null; status: "ok" | "invalid_output" | "failed"; output?: z.infer<typeof ReconcilerOutput> | null; error?: string }>;

/** The AI pass: annotates verdicts for the reviewer. Runs through agentRunner
 * (first-party API or AWS Bedrock via USE_BEDROCK); injectable for tests.
 * Failure is non-fatal — candidates alone still ship to the dashboard. */
export async function reconcileRecordChangeSet(
  id: string,
  deps: { runner?: StructuredRunner } = {},
): Promise<ReconciliationReport | null> {
  const changeSet = getRecordChangeSet(id);
  if (!changeSet || changeSet.status !== "ready_for_review") return null;
  const candidates = reconciliationCandidates(changeSet.operations);

  let verdicts: Record<string, Verdict> | undefined;
  let reasons: Record<string, string> | undefined;
  let agentRunId: string | null = null;

  const hasCandidates = Object.values(candidates).some(rows => rows.length > 0);
  if (hasCandidates && deps.runner !== undefined) {
    // Build a small workspace for the audit trail, then ask the model to
    // classify each row against its candidates.
    const { newWorkspace } = await import("./agentRunner");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = newWorkspace("record_reconciler");
    writeFileSync(join(dir, "summary.md"), changeSet.summaryMd);
    writeFileSync(join(dir, "operations.json"), JSON.stringify(changeSet.operations, null, 2));
    writeFileSync(join(dir, "candidates.json"), JSON.stringify(candidates, null, 2));
    const run = await deps.runner("record_reconciler", dir, ReconcilerOutput, { trigger: "manual" });
    agentRunId = run.runId;
    if (run.status === "ok" && run.output) {
      verdicts = {};
      reasons = {};
      for (const v of run.output.verdicts) {
        if (!(v.temp_id in candidates)) continue; // grounding: only rows we sent
        reasons[v.temp_id] = v.reason;
        if (v.verdict === "version_bump" && v.of_lineage_id) {
          verdicts[v.temp_id] = { verdict: "version_bump", ofLineageId: v.of_lineage_id };
        } else if (v.verdict === "link_existing" && v.of_lineage_id) {
          verdicts[v.temp_id] = { verdict: "link_existing", lineageId: v.of_lineage_id };
        } else if (v.verdict === "new") {
          verdicts[v.temp_id] = { verdict: "new" };
        }
        // remix suggestions without parent ids are left for the human
      }
    }
  }

  const report: ReconciliationReport = { candidates, verdicts, reasons, agentRunId };
  db.update(draftChangeSet)
    .set({ reconciliationJson: JSON.stringify(report) })
    .where(eq(draftChangeSet.id, id))
    .run();
  emit("draft_change_set", id, "record_change_set_reconciled", { agentRunId });
  return report;
}
