import { IMessageSDK, type Message } from "@photon-ai/imessage-kit";
import { backend, type SendableRow } from "./backend";

// The dream system's wire daemon: a dumb pipe between the backend's outbox and
// this Mac's Messages.app. It never composes words and never decides who hears
// what — the backend renders every message; this loop only delivers, relays
// inbound, and publishes the list of real group chats for the link picker.
//
// Runs on the ALWAYS-ON MAC, not the VM: the kit reads ~/Library/Messages/
// chat.db and dispatches sends through Messages.app, so it needs macOS, Full
// Disk Access, and a signed-in Messages account. The backend stays wherever it
// lives; this talks to it purely over HTTP (BACKEND_URL).
//
// Identity note: sends go out as whatever Apple Account Messages.app is signed
// into. For the witness design to hold, that must be the BOT's own account —
// otherwise the agent texts as the user and the third-voice effect dies.

const sdk = new IMessageSDK();
const POLL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 20) * 1000;

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
      // send() resolves on AppleScript dispatch and never waits for chat.db —
      // there is no transport id, so we mint one for the audit trail.
      await sdk.send({ to: row.chatId, text: row.bodyText });
      await backend.markSent(row.id, `local-${crypto.randomUUID()}`);
      console.log(`[outbound] ${row.kind} → ${row.chatId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[outbound] ${row.id} failed:`, msg);
      await reportWithRetry(() => backend.markFailed(row.id, msg), `mark-failed ${row.id}`);
    }
  }
}

// --- groups: publish real chats so the dashboard can offer a link picker ---
// The kit is explicit that group chatIds encode Messages.app internals and must
// never be constructed — they come from here or from an inbound message.

async function publishGroups() {
  try {
    const chats = await sdk.listChats({ kind: "group", service: "iMessage", sortBy: "recent", limit: 30 });
    await backend.publishGroups(
      chats.map(c => ({ chatId: c.chatId, name: c.name ?? null, isArchived: c.isArchived })),
    );
  } catch (e) {
    console.error("[groups] publish failed:", e instanceof Error ? e.message : e);
  }
}

// The backend can be down exactly when we need to record a terminal result.
// Retry briefly rather than lose it (a swallowed report strands the UI).
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

// --- inbound: relay everything to the backend; it decides what it means ---

async function relay(m: Message) {
  if (!m.chatId || !m.text) return;
  try {
    const result = await backend.inbound({
      chatId: m.chatId,
      senderHandle: m.participant ?? "unknown",
      text: m.text,
      sentAt: new Date().toISOString(),
      messageId: m.id,
    });
    console.log(`[inbound] ${m.chatKind} ${m.chatId} → ${result.action}`);
  } catch (e) {
    console.error("[inbound] relay failed:", e instanceof Error ? e.message : e);
  }
}

async function pollForever() {
  for (;;) {
    await publishGroups();
    await deliverOutbound();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

await sdk.startWatching({
  // Peers only — onIncomingMessage excludes our own sends, so the bot can
  // never react to itself.
  onGroupMessage: relay,
  onDirectMessage: relay,
  onError: e => console.error("[kit]", e.message),
});
console.log(`[messenger] watching Messages.app — polling backend every ${POLL_MS / 1000}s`);
pollForever();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`\n[messenger] ${sig} — closing`);
    await sdk.close().catch(() => {});
    process.exit(0);
  });
}
