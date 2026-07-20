import { Hono } from "hono";
import { setConfig } from "../../services/config";
import { emit } from "../../services/events";

export const userRoutes = new Hono();

// The glance ping; "last visit" also lazily kicks the calendar sync so tokens
// and quota are only spent on days the user actually looks.
userRoutes.post("/visit", c => {
  setConfig("LAST_VISIT_AT", new Date().toISOString());
  emit("user", null, "visit");
  import("../../services/calendarSync")
    .then(({ syncIfStale, isConnected }) => (isConnected() ? syncIfStale() : null))
    .catch(() => {});
  return c.json({ ok: true });
});
