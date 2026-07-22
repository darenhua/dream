import { Hono } from "hono";
import { computeStrikes, pauseStrikes, resumeStrikes } from "../../services/strikes";
import { computeVitals } from "../../services/vitals";
import { todayLocal } from "../../lib/time";

// Self-visibility before social visibility: the user sees every derived
// signal (and the strike count) on the dashboard before any friend does.
export const vitalsRoutes = new Hono();

vitalsRoutes.get("/", c => {
  const asOf = todayLocal();
  const vitals = computeVitals(asOf);
  return c.json({ asOf, vitals, strikes: computeStrikes(asOf, vitals) });
});

export const strikeRoutes = new Hono();

strikeRoutes.get("/", c => {
  return c.json(computeStrikes(todayLocal()));
});

strikeRoutes.post("/pause", async c => {
  const body = await c.req.json().catch(() => ({}));
  const days = Number(body.days);
  if (!Number.isFinite(days) || days <= 0) {
    return c.json({ error: "pause requires {days: positive number, reason?: string}" }, 400);
  }
  return c.json(pauseStrikes(days, body.reason));
});

strikeRoutes.post("/resume", c => {
  resumeStrikes();
  return c.json({ ok: true });
});
