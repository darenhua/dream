import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { category, conversation, rantLink } from "../db/schema";
import { getConfig } from "./config";
import { emit } from "./events";

// Amendment 2 — runs on every link creation: the newest K active links stay,
// older non-pinned ones auto-demote. Pinned links are never demoted (amendment 3).
export function rebalanceCategory(categoryId: string) {
  const cat = db.select().from(category).where(eq(category.id, categoryId)).get();
  if (!cat) return;
  const k = cat.topKOverride ?? getConfig<number>("TOP_K_RANTS");

  const active = db
    .select({
      linkId: rantLink.id,
      pinned: rantLink.pinned,
      sourceUpdatedAt: conversation.sourceUpdatedAt,
    })
    .from(rantLink)
    .innerJoin(conversation, eq(rantLink.conversationId, conversation.id))
    .where(and(eq(rantLink.categoryId, categoryId), eq(rantLink.activeForDerive, true)))
    .orderBy(desc(conversation.sourceUpdatedAt))
    .all();

  for (const link of active.slice(k)) {
    if (link.pinned) continue;
    db.update(rantLink).set({ activeForDerive: false }).where(eq(rantLink.id, link.linkId)).run();
    emit("rant_link", link.linkId, "auto_demoted_from_top_k", { categoryId });
  }
}

export function createLink(
  conversationId: string,
  categoryId: string,
  source: "agent" | "manual",
): { link: typeof rantLink.$inferSelect; created: boolean } {
  const existing = db
    .select()
    .from(rantLink)
    .where(and(eq(rantLink.conversationId, conversationId), eq(rantLink.categoryId, categoryId)))
    .get();
  if (existing) return { link: existing, created: false };

  const link = db
    .insert(rantLink)
    .values({ conversationId, categoryId, activeForDerive: true, source })
    .returning()
    .get();
  emit("rant_link", link.id, "link_created", { conversationId, categoryId, source });
  rebalanceCategory(categoryId);
  return { link, created: true };
}

export function deleteLink(conversationId: string, categoryId: string): boolean {
  const existing = db
    .select()
    .from(rantLink)
    .where(and(eq(rantLink.conversationId, conversationId), eq(rantLink.categoryId, categoryId)))
    .get();
  if (!existing) return false;
  db.delete(rantLink).where(eq(rantLink.id, existing.id)).run();
  emit("rant_link", existing.id, "link_deleted", { conversationId, categoryId });
  return true;
}

// Manual PATCH: setting active=true pins the link (exempt from auto-demotion);
// setting false clears the pin.
export function patchLink(linkId: string, activeForDerive: boolean) {
  const existing = db.select().from(rantLink).where(eq(rantLink.id, linkId)).get();
  if (!existing) return null;
  const updated = db
    .update(rantLink)
    .set({ activeForDerive, pinned: activeForDerive })
    .where(eq(rantLink.id, linkId))
    .returning()
    .get();
  emit("rant_link", linkId, "link_patched", { activeForDerive, pinned: activeForDerive });
  if (activeForDerive) rebalanceCategory(existing.categoryId);
  return updated;
}
