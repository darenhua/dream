import { app } from "./app";
import { env } from "../lib/env";
import { initMessaging } from "../services/messaging/messenger";

// Give the strike tripwire its delivery sink (mock transport until a real one
// is configured) — registration only; nothing sends without an approved row.
initMessaging();

Bun.serve({ port: env.PORT, fetch: app.fetch });
console.log(`dream backend listening on http://localhost:${env.PORT}`);
