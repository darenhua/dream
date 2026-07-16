import { env } from "../lib/env";
import { startBackendServer } from "./httpServer";
import { initMessaging } from "../services/messaging/messenger";

// Give the strike tripwire its delivery sink (mock transport until a real one
// is configured) — registration only; nothing sends without an approved row.
initMessaging();

startBackendServer();
console.log(`dream backend listening on http://${env.BIND_HOST}:${env.PORT}`);
