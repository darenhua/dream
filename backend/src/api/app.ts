import { Hono } from "hono";
import { adminRoutes } from "./routes/admin";
import { categoryRoutes } from "./routes/categories";
import { configRoutes } from "./routes/config";
import { conversationRoutes } from "./routes/conversations";
import { eventRoutes } from "./routes/events";
import { jobRoutes } from "./routes/jobs";
import { proposalRoutes } from "./routes/proposals";
import { rantLinkRoutes } from "./routes/rantLinks";

export const app = new Hono();

app.get("/api/admin/health", c => c.json({ ok: true }));

app.route("/api/admin", adminRoutes);
app.route("/api/config", configRoutes);
app.route("/api/events", eventRoutes);
app.route("/api/conversations", conversationRoutes);
app.route("/api/categories", categoryRoutes);
app.route("/api/rant-links", rantLinkRoutes);
app.route("/api/proposals", proposalRoutes);
app.route("/api/jobs", jobRoutes);
