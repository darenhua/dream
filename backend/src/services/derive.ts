import { eq } from "drizzle-orm";
import { db } from "../db";
import { category } from "../db/schema";
import { DeriverOutput } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { getConfig } from "./config";
import { emit } from "./events";
import { newWorkspace, projectCategory } from "./projector";
import { createProposal, supersedePending } from "./proposals";

// §8.3 — the heart: supersede → project → derive → ≤MAX proposals.
export async function deriveCategory(categoryId: string, trigger: "daily" | "manual") {
  const cat = db.select().from(category).where(eq(category.id, categoryId)).get();
  if (!cat) throw new Error(`category ${categoryId} not found`);

  const superseded = supersedePending(`category:${categoryId}`);

  const dir = newWorkspace("deriver");
  projectCategory(categoryId, dir);
  const run = await runStructured("deriver", dir, DeriverOutput, { trigger });

  if (run.status !== "ok" || !run.output) {
    emit("category", categoryId, "derive_failed", { agentRunId: run.runId, error: run.error });
    return { categoryId, superseded, proposals: 0, status: run.status, error: run.error };
  }

  const cap = getConfig<number>("MAX_PROPOSALS_PER_DERIVE");
  const proposals = run.output.proposals.slice(0, cap); // importance-ordered; overflow dropped
  for (const p of proposals) {
    createProposal(p.kind, p, `category:${categoryId}`, run.runId);
  }
  emit("category", categoryId, "derive_completed", {
    agentRunId: run.runId,
    proposals: proposals.length,
    superseded,
  });
  return { categoryId, superseded, proposals: proposals.length, status: "ok" as const };
}

// Sequential per spec — one category at a time, one failure doesn't hide the rest.
export async function deriveAll(trigger: "daily" | "manual") {
  const cats = db.select().from(category).where(eq(category.status, "active")).all();
  const results = [];
  for (const cat of cats) {
    try {
      results.push(await deriveCategory(cat.id, trigger));
    } catch (e) {
      results.push({
        categoryId: cat.id,
        superseded: 0,
        proposals: 0,
        status: "failed" as const,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { derived: results.length, results };
}
