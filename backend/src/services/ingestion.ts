import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { conversation } from "../db/schema";
import { ParseError, detectSlug, parseConversation } from "../domain/parser";
import { getConfig } from "./config";
import { emit } from "./events";

export interface IngestReport {
  new: number;
  updated: number;
  unchanged: number;
  errors: { externalId: string | null; reason: string }[];
}

function hashContent(contentJson: string): string {
  return new Bun.CryptoHasher("sha256").update(contentJson).digest("hex");
}

// §8.1 — upsert per A7: source updated_at equal → skip; else re-parse, re-hash,
// re-run slug detection. One bad conversation never kills a batch.
export function ingestFile(payload: unknown): IngestReport {
  if (!Array.isArray(payload)) {
    throw new Error("expected the raw Claude conversations.json: a JSON array of conversations");
  }

  const report: IngestReport = { new: 0, updated: 0, unchanged: 0, errors: [] };
  const slug = getConfig<string>("SLUG_MARKER");

  for (const raw of payload) {
    const externalId = typeof raw?.uuid === "string" ? raw.uuid : null;
    const existing = externalId
      ? db
          .select()
          .from(conversation)
          .where(and(eq(conversation.source, "claude"), eq(conversation.externalId, externalId)))
          .get()
      : undefined;

    try {
      const parsed = parseConversation(raw);

      // Cheap first-pass filter: same source updated_at → nothing to do.
      if (existing && existing.sourceUpdatedAt === parsed.sourceUpdatedAt) {
        report.unchanged++;
        continue;
      }

      const contentJson = JSON.stringify(parsed.messages);
      const contentHash = hashContent(contentJson);

      if (existing && existing.contentHash === contentHash) {
        // Metadata-only change (e.g. rename); refresh it, count as unchanged.
        db.update(conversation)
          .set({
            title: parsed.title,
            sourceUpdatedAt: parsed.sourceUpdatedAt,
            rawJson: JSON.stringify(raw),
          })
          .where(eq(conversation.id, existing.id))
          .run();
        report.unchanged++;
        continue;
      }

      const { slugDetected, slugMessageIdx } = detectSlug(parsed.messages, slug);

      if (existing) {
        // Content changed: re-detect slug; a conversation gaining a slug enters the
        // distill queue now. Pipeline timestamps are deliberately left untouched —
        // reprocessing an already-distilled conversation is an explicit admin action.
        db.update(conversation)
          .set({
            title: parsed.title,
            contentJson,
            rawJson: JSON.stringify(raw),
            contentHash,
            sourceUpdatedAt: parsed.sourceUpdatedAt,
            slugDetected,
            slugMessageIdx,
            parseError: null,
          })
          .where(eq(conversation.id, existing.id))
          .run();
        report.updated++;
        emit("conversation", existing.id, "conversation_updated", { slugDetected });
      } else {
        const inserted = db
          .insert(conversation)
          .values({
            source: "claude",
            externalId: parsed.externalId,
            title: parsed.title,
            contentJson,
            rawJson: JSON.stringify(raw),
            contentHash,
            sourceCreatedAt: parsed.sourceCreatedAt,
            sourceUpdatedAt: parsed.sourceUpdatedAt,
            slugDetected,
            slugMessageIdx,
          })
          .returning({ id: conversation.id })
          .get();
        report.new++;
        emit("conversation", inserted.id, "conversation_ingested", { slugDetected });
      }
    } catch (e) {
      const reason = e instanceof ParseError ? e.reason : e instanceof Error ? e.message : String(e);
      report.errors.push({ externalId, reason });

      // raw_json is always stored, even on parse failure (A6) — but never clobber
      // an existing row's good content with a failed parse.
      if (externalId && !existing) {
        const inserted = db
          .insert(conversation)
          .values({
            source: "claude",
            externalId,
            title: typeof raw?.name === "string" ? raw.name : null,
            rawJson: JSON.stringify(raw),
            sourceCreatedAt: typeof raw?.created_at === "string" ? raw.created_at : null,
            sourceUpdatedAt: typeof raw?.updated_at === "string" ? raw.updated_at : null,
            parseError: reason,
          })
          .returning({ id: conversation.id })
          .get();
        emit("conversation", inserted.id, "conversation_parse_failed", { reason });
      } else if (existing) {
        emit("conversation", existing.id, "conversation_reparse_failed", { reason });
      }
    }
  }

  emit("import", null, "import_completed", report);
  return report;
}
