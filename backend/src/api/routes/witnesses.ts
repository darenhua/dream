import { Hono } from "hono";
import {
  createInvite,
  getWitness,
  listWitnesses,
  patchWitness,
  removeWitness,
  setGoals,
  setPrimary,
} from "../../services/witnesses";
import { witnessContextMd } from "../../services/witnessScope";

export const witnessRoutes = new Hono();

witnessRoutes.get("/", c => c.json(listWitnesses()));

witnessRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "invite requires {name, handle?, timezone?, isPrimary?, goalIds?}" }, 400);
  }
  return c.json(
    createInvite({
      name: body.name,
      handle: body.handle,
      timezone: body.timezone,
      isPrimary: body.isPrimary === true,
      goalIds: Array.isArray(body.goalIds) ? body.goalIds : [],
    }),
  );
});

witnessRoutes.patch("/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  const updated = patchWitness(c.req.param("id"), body);
  if (!updated) return c.json({ error: "witness not found" }, 404);
  return c.json(updated);
});

witnessRoutes.put("/:id/goals", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!getWitness(c.req.param("id"))) return c.json({ error: "witness not found" }, 404);
  const goalIds = setGoals(c.req.param("id"), Array.isArray(body.goalIds) ? body.goalIds : []);
  return c.json({ ok: true, goalIds });
});

witnessRoutes.post("/:id/primary", c => {
  try {
    setPrimary(c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
  }
});

// What this witness would see — the scoped projection, for the user to sanity-
// check the boundary before anything is ever composed.
witnessRoutes.get("/:id/preview", c => {
  if (!getWitness(c.req.param("id"))) return c.json({ error: "witness not found" }, 404);
  return c.json({ contextMd: witnessContextMd(c.req.param("id")) });
});

witnessRoutes.delete("/:id", c => {
  if (!removeWitness(c.req.param("id"))) return c.json({ error: "witness not found" }, 404);
  return c.json({ ok: true });
});
