import { Hono } from "hono";
import { adminRoutes } from "./routes/admin";
import { agentRunRoutes } from "./routes/agentRuns";
import { anchorRoutes, calendarRoutes } from "./routes/calendar";
import { chatRoutes } from "./routes/chat";
import { configRoutes } from "./routes/config";
import { conversationRoutes } from "./routes/conversations";
import { eventRoutes } from "./routes/events";
import { experimentRoutes } from "./routes/experiments";
import { extractionRoutes } from "./routes/extractions";
import { goalRoutes } from "./routes/goals";
import { jobRoutes } from "./routes/jobs";
import { proposalRoutes } from "./routes/proposals";
import { environmentRoutes, experienceRoutes, habitRoutes, projectRoutes } from "./routes/registries";
import { userRoutes, writeupRoutes } from "./routes/user";
import { strikeRoutes, vitalsRoutes } from "./routes/vitals";
import { witnessRoutes } from "./routes/witnesses";
import { reviewRoutes } from "./routes/reviews";
import { outboxRoutes } from "./routes/outbox";
import { l3Routes } from "./routes/l3";
import { messagingRoutes } from "./routes/messaging";
import { steeringRoutes } from "./routes/steering";
import { mcpRoutes } from "../mcp/http";
import { configureCollaborationMcpBackend } from "../mcp/server";
import { collaborationMcpBackend } from "../services/collaboration";
import { collaborationRoutes } from "./routes/collaboration";
import { companionRoutes } from "./routes/companion";
import { organizedRoutes } from "./routes/organized";

export const app = new Hono();

// The MCP transport is intentionally persistence-blind. Register its one
// workspace-scoped adapter at process startup; it exposes drafts only and has
// no route to apply organized/raw/calendar/witness state.
configureCollaborationMcpBackend(collaborationMcpBackend);

app.route("/api/admin", adminRoutes);
app.route("/api/config", configRoutes);
app.route("/api/events", eventRoutes);
app.route("/api/conversations", conversationRoutes);
app.route("/api/extractions", extractionRoutes);
app.route("/api/proposals", proposalRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/goals", goalRoutes);
app.route("/api/habits", habitRoutes);
app.route("/api/environment", environmentRoutes);
app.route("/api/experiences", experienceRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/experiments", experimentRoutes);
app.route("/api/chat", chatRoutes);
app.route("/api/calendar", calendarRoutes);
app.route("/api/anchors", anchorRoutes);
app.route("/api/user", userRoutes);
app.route("/api/writeup", writeupRoutes);
app.route("/api/vitals", vitalsRoutes);
app.route("/api/strikes", strikeRoutes);
app.route("/api/witnesses", witnessRoutes);
app.route("/api/reviews", reviewRoutes);
app.route("/api/outbox", outboxRoutes);
app.route("/api/l3", l3Routes);
app.route("/api/messaging", messagingRoutes);
app.route("/api/steer", steeringRoutes);
app.route("/api/agent-runs", agentRunRoutes);
app.route("/api/organized", organizedRoutes);
app.route("/api/collaboration", collaborationRoutes);
// Companion inbox: fail-closed reviewer identity; see routes/companion.ts.
app.route("/api/companion", companionRoutes);
app.route("/", mcpRoutes);
