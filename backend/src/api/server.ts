import { app } from "./app";
import { env } from "../lib/env";

Bun.serve({ port: env.PORT, fetch: app.fetch });
console.log(`dream backend listening on http://localhost:${env.PORT}`);
