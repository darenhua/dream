import { desc, eq, and } from "drizzle-orm";
import { db } from "../db";
import { event } from "../db/schema";

// §7.11 / G9 — every mutation calls this; trajectory assembles itself as a side effect.
export function emit(
  entityType: string,
  entityId: string | null,
  eventType: string,
  payload?: unknown,
) {
  db.insert(event)
    .values({
      entityType,
      entityId,
      eventType,
      payloadJson: payload === undefined ? null : JSON.stringify(payload),
    })
    .run();
}

export function listEvents(opts: { entityType?: string; entityId?: string; limit?: number }) {
  const conds = [];
  if (opts.entityType) conds.push(eq(event.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(event.entityId, opts.entityId));
  return db
    .select()
    .from(event)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(event.createdAt))
    .limit(opts.limit ?? 100)
    .all();
}
