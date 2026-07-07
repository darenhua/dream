import { Hono } from "hono";
import { patchLink } from "../../services/rantLinks";

export const rantLinkRoutes = new Hono();

rantLinkRoutes.patch("/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.active_for_derive !== "boolean") {
    return c.json({ error: "active_for_derive (boolean) required" }, 400);
  }
  const updated = patchLink(c.req.param("id"), body.active_for_derive);
  if (!updated) return c.json({ error: "rant link not found" }, 404);
  return c.json(updated);
});
