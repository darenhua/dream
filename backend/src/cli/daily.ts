// `bun run heartbeat` (alias: `bun run daily`) — the cron entrypoint (§8.9 / N5).
import { runHeartbeat } from "../services/daily";

const report = await runHeartbeat("daily");
console.log(JSON.stringify(report, null, 2));
