// Bulk-import a Claude conversations.json straight off disk, bypassing HTTP
// entirely — for backlogs too large to survive Vercel's ~4.5MB rewrite body
// cap. Talks to the same sqlite file the running server uses (WAL mode
// tolerates this fine); the running process doesn't need to be restarted.
//
//   bun run scripts/import-file.ts /path/to/conversations.json
//
// Respects AUTO_DETECT exactly like POST /api/admin/import: leave it false
// during a big backlog import and classify at your own pace in the rant
// explorer afterward.
import { getConfig } from "../src/services/config";
import { detectPendingRants } from "../src/services/rantDetection";
import { distillPending } from "../src/services/distill";
import { ingestFile } from "../src/services/ingestion";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run scripts/import-file.ts <path-to-conversations.json>");
  process.exit(1);
}

const payload = await Bun.file(path).json();
const report = ingestFile(payload);
console.log(JSON.stringify(report, null, 2));

if (getConfig<boolean>("AUTO_DETECT")) {
  console.log("AUTO_DETECT is on — classifying now (this may take a while for a large backlog)...");
  console.log(JSON.stringify(await detectPendingRants("manual"), null, 2));
  console.log(JSON.stringify(await distillPending("manual"), null, 2));
} else {
  console.log("AUTO_DETECT is off — import is inert. Classify at your pace in the admin rant explorer.");
}
