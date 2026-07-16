import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { backend, type LinkRequest, type SendableRow } from "./backend";

// The dream system's wire daemon: a dumb pipe between the backend's outbox
// and Photon-managed iMessage lines. Runs side by side with the backend (its
// own process + systemd unit). It never composes words, never decides who
// hears what — the backend renders every message; this loop just delivers,
// creates witness group chats on request, and relays inbound.

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);

const POLL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 20) * 1000;
console.log(`[messenger] connected — polling backend every ${POLL_MS / 1000}s`);

// --- outbound: approved rows past their notBefore, linked chats only ---

async function deliverOutbound() {
  let rows: SendableRow[];
  try {
    rows = await backend.sendable();
  } catch (e) {
    console.error("[outbound] backend unreachable:", e instanceof Error ? e.message : e);
    return;
  }
  for (const row of rows) {
    try {
      const space = await im.space.get(row.chatId);
      if (!space) throw new Error(`space ${row.chatId} not found`);
      const sent = await space.send(row.bodyText);
      await backend.markSent(row.id, (sent as { id?: string })?.id ?? "sent");
      console.log(`[outbound] ${row.kind} → ${row.chatId.slice(0, 18)}…`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[outbound] ${row.id} failed:`, msg);
      await backend.markFailed(row.id, msg).catch(() => {});
    }
  }
}

// --- linking: create the group (user + friend), name it, send the welcome ---

async function processLinkRequests() {
  let requests: LinkRequest[];
  try {
    requests = await backend.linkRequests();
  } catch {
    return; // backend unreachable — outbound loop already logged it
  }
  for (const req of requests) {
    if (!req.userHandle) {
      await backend
        .linkFailed(req.witnessId, "USER_IMESSAGE_HANDLE not set in backend config — add your own phone/email first")
        .catch(() => {});
      console.error(`[link] ${req.name}: no user handle configured`);
      continue;
    }
    try {
      const group = await im.space.create([req.userHandle, req.handle]);
      await group.rename(req.groupName).catch(() => {}); // cosmetic — never fail the link over it
      await group.send(req.welcomeText);
      await backend.linked(req.witnessId, group.id);
      console.log(`[link] created group for ${req.name} → ${group.id.slice(0, 18)}…`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[link] ${req.name} failed:`, msg);
      // Report with retries: if the backend is down, a swallowed report leaves
      // linkRequestedAt set forever — the dashboard spins on "creating group…"
      // and every poll retries the same doomed create.
      await reportWithRetry(() => backend.linkFailed(req.witnessId, msg), `link-failed ${req.name}`);
    }
  }
}

// The backend can be down (restart, deploy) exactly when we need to record a
// terminal result. Retry briefly rather than lose it.
async function reportWithRetry(fn: () => Promise<unknown>, label: string, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      if (i === attempts - 1) {
        console.error(`[report] ${label} could not be recorded:`, e instanceof Error ? e.message : e);
        return;
      }
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// --- poll loop (outbound + links), independent of the inbound stream ---

async function pollForever() {
  for (;;) {
    await processLinkRequests();
    await deliverOutbound();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
pollForever();

// --- inbound: relay everything to the backend; it decides what it means ---

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  try {
    const result = await backend.inbound({
      chatId: space.id,
      senderHandle: message.sender?.id ?? "unknown", // iMessage user ids are the handle (phone/email)
      text: message.content.text,
      sentAt: new Date().toISOString(),
      messageId: message.id,
    });
    console.log(`[inbound] ${space.id.slice(0, 18)}… → ${result.action}`);
  } catch (e) {
    console.error("[inbound] relay failed:", e instanceof Error ? e.message : e);
  }
}
