// `bun run daily` — the cron entrypoint (§8.9 / N5).
import { runDaily } from "../services/daily";

const report = await runDaily("daily");
console.log(JSON.stringify(report, null, 2));
