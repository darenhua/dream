import { Hono } from "hono";
import {
  createEnvironmentItem,
  listEnvironment,
  patchEnvironmentItem,
} from "../../services/environment";
import { createExperience, listExperiences, markExperienceHad } from "../../services/experiences";
import {
  createHabit,
  linkHabitToGoal,
  listHabits,
  patchHabit,
  unlinkHabitFromGoal,
} from "../../services/habits";
import { linkEnvironmentToGoal } from "../../services/environment";

// --- habits ---

export const habitRoutes = new Hono();

habitRoutes.get("/", c => c.json(listHabits(c.req.query("status") || undefined)));

habitRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.title) return c.json({ error: "title required" }, 400);
  const row = createHabit({
    title: body.title,
    note: body.note ?? null,
    valence: body.valence,
    status: body.status ?? "established",
    rrule: body.rrule ?? null,
    preferredTime: body.preferredTime ?? null,
    durationMinutes: body.durationMinutes ?? null,
    origin: "manual",
    goalIds: Array.isArray(body.goalIds) ? body.goalIds : undefined,
  });
  return c.json(row, 201);
});

habitRoutes.patch("/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  const row = patchHabit(c.req.param("id"), body);
  if (!row) return c.json({ error: "habit not found" }, 404);
  return c.json(row);
});

habitRoutes.post("/:id/goals/:goalId", c => {
  linkHabitToGoal(c.req.param("goalId"), c.req.param("id"));
  return c.json({ ok: true });
});

habitRoutes.delete("/:id/goals/:goalId", c => {
  const ok = unlinkHabitFromGoal(c.req.param("goalId"), c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "link not found" }, 404);
});

// --- environment ---

export const environmentRoutes = new Hono();

environmentRoutes.get("/", c =>
  c.json(
    listEnvironment({
      subKind: c.req.query("subKind") || undefined,
      status: c.req.query("status") || undefined,
    }),
  ),
);

environmentRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.title || !body.subKind) return c.json({ error: "title and subKind required" }, 400);
  const row = createEnvironmentItem({
    title: body.title,
    subKind: body.subKind,
    note: body.note ?? null,
    rrule: body.rrule ?? null,
    durationMinutes: body.durationMinutes ?? null,
    origin: "manual",
    goalIds: Array.isArray(body.goalIds) ? body.goalIds : undefined,
  });
  return c.json(row, 201);
});

environmentRoutes.patch("/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  const row = patchEnvironmentItem(c.req.param("id"), body);
  if (!row) return c.json({ error: "environment item not found" }, 404);
  return c.json(row);
});

environmentRoutes.post("/:id/goals/:goalId", c => {
  linkEnvironmentToGoal(c.req.param("goalId"), c.req.param("id"));
  return c.json({ ok: true });
});

// --- experiences (append-only; no delete, no prune) ---

export const experienceRoutes = new Hono();

experienceRoutes.get("/", c => c.json(listExperiences(c.req.query("state") || undefined)));

experienceRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.title) return c.json({ error: "title required" }, 400);
  const row = createExperience({
    title: body.title,
    note: body.note ?? null,
    state: body.state ?? "had",
    plannedFor: body.plannedFor ?? null,
    origin: "manual",
  });
  return c.json(row, 201);
});

experienceRoutes.post("/:id/had", async c => {
  const body = await c.req.json().catch(() => ({}));
  const row = markExperienceHad(c.req.param("id"), body.note);
  if (!row) return c.json({ error: "experience not found" }, 404);
  return c.json(row);
});
