import { Hono } from "hono";
import { adminRoutes } from "./routes/admin";
import { configRoutes } from "./routes/config";
import { eventRoutes } from "./routes/events";

export const app = new Hono();

app.get("/api/admin/health", c => c.json({ ok: true }));

app.route("/api/admin", adminRoutes);
app.route("/api/config", configRoutes);
app.route("/api/events", eventRoutes);
