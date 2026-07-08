import { Hono } from "hono";
import { setConfig } from "../../services/config";
import { emit } from "../../services/events";
import { getWriteup, latestWriteup, listWriteups, todayLocal } from "../../services/writeup";

export const userRoutes = new Hono();

// §7.13 — the glance ping; "last visit" feeds the writeup's re-entry warmth.
userRoutes.post("/visit", c => {
  setConfig("LAST_VISIT_AT", new Date().toISOString());
  emit("user", null, "visit");
  return c.json({ ok: true });
});

export const writeupRoutes = new Hono();

// §9 amendment (dashboard history view): recent writeups, newest first.
writeupRoutes.get("/history", c => {
  const { limit } = c.req.query();
  return c.json(listWriteups(limit ? Number(limit) : 30));
});

writeupRoutes.get("/today", c => {
  // Today's if it exists, else the latest — the glance never shows a hole.
  const writeup = getWriteup(todayLocal()) ?? latestWriteup();
  if (!writeup) return c.json({ error: "no writeup yet" }, 404);
  return c.json(writeup);
});

writeupRoutes.get("/", c => {
  const { date } = c.req.query();
  if (!date) return c.json({ error: "date query param required (YYYY-MM-DD)" }, 400);
  const writeup = getWriteup(date);
  if (!writeup) return c.json({ error: `no writeup for ${date}` }, 404);
  return c.json(writeup);
});
