# Plan: switch the messenger from Photon Cloud → local iMessage Kit

*Branch: `photon-messenger` (incomplete — this is the remaining work). Written 2026-07-16 after the cloud probe failed.*

## Context

Phase 7 shipped the witness bot on **Photon Spectrum Cloud** (`spectrum-ts`). Live probing killed it: the hosted free/pro tier is **DM-only**, and Photon's docs are explicit —

> "Shared-pool mode does not create group chats and does not subscribe to iMessage's group-event stream."

So on the current plan the bot is *structurally deaf in groups*: the JOIN handshake can never arrive, and `space.create([user, friend])` throws `UnsupportedError`. Hosted groups start at **Business, $250/line/month**. Pro ($25) does **not** unlock them.

The escape is the **MIT-licensed `@photon-ai/imessage-kit`** (v3.0.0, verified on npm): free, runs against a Mac's own Messages.app, and **does support groups** — list existing, receive with sender identity, send into them. It cannot *create* groups or do advanced management (rename/icon/participants), which we don't need: the user creates the group by hand once, exactly like they already did.

**Intended outcome:** identical product behavior (goal-scoped, approval-gated witness messages landing in a real group chat), zero recurring cost, and the backend untouched.

## What makes this cheap

The side-by-side split already isolates the wire. **Nothing in `backend/` changes.** The composer, outbox, approval gate, scope filtering, strike engine, and the whole `/api/messaging/*` contract are transport-agnostic by design — `ChatTransport` was built for exactly this swap. The work is confined to `messenger/`, one schema column, and the link UI.

## Prerequisites (user, one-time — do these first; they gate everything)

1. **A dedicated Apple Account for the bot.** *This is the load-bearing decision.* The kit sends as whatever identity Messages.app is signed into. If that's your personal account, the bot's messages arrive **as you** — which destroys the third-voice effect the whole feature rests on (you'd be announcing your own strike alerts). An Apple Account *email* works; no SIM needed.
2. **An always-on Mac** (or a macOS user account you leave logged in) with Messages.app signed into that bot account. Note: Messages holds one iMessage identity at a time — so the bot needs its own macOS user session or its own machine, not just another "reachable at" address.
3. **Full Disk Access** for the runtime (Terminal/bun) — System Settings → Privacy & Security → Full Disk Access. The kit reads `chat.db`.
4. **Automation permission** to control Messages.app (macOS will prompt on first send).
5. **Create the group in Messages**: you + friend + the bot's Apple Account. Blue bubbles (iMessage, not SMS).

## Phase A — swap the transport

**`messenger/package.json`**: drop `spectrum-ts`, add `@photon-ai/imessage-kit` (^3.0.0). Node ≥20 / Bun.

**`messenger/src/index.ts`** — replace the Spectrum init + stream with the kit:

```ts
import { IMessageSDK } from "@photon-ai/imessage-kit";
const sdk = new IMessageSDK();

await sdk.startWatching({
  onGroupMessage: async m => {
    if (!m.chatId || !m.text) return;
    await backend.inbound({
      chatId: m.chatId,
      senderHandle: m.participant ?? "unknown", // maps 1:1 to today's senderHandle
      text: m.text,
      messageId: m.guid,          // confirm exact field name at build time
    });
  },
  onDirectMessage: async m => { /* same — DMs still work */ },
  onError: e => console.error("[kit]", e),
});
```

Outbound becomes `await sdk.send({ to: row.chatId, text: row.bodyText })`.

**Two real API differences to handle:**

1. **`send()` returns `Promise<void>`** — it resolves on AppleScript *dispatch* and never waits for chat.db arrival. There is no transport message id. So `backend.markSent(id, transportMessageId)` gets a synthetic id (e.g. `local-<uuid>`). If we want true delivery confirmation later, the kit's own docs name `onFromMeMessage` as "the authoritative source of 'my send landed in chat.db'" — wire that as a follow-up, not now.
2. **Never construct chatIds.** The kit warns group ids "encode Messages.app internals". They must come from `listChats()` or an inbound `message.chatId`. This is why Phase B exists.

Keep unchanged: the poll loop, `backend.ts` client, `reportWithRetry`, and the `TRANSPORT=external` gate (one wire owns delivery).

## Phase B — replace group *creation* with group *picking*

Auto-create is gone, and the JOIN-code dance becomes unnecessary — we can just **show the user their real groups**. This is better UX than typing codes.

- **Daemon**: new endpoint-driven task — on request, `sdk.listChats({ kind: "group", service: "iMessage", sortBy: "recent", limit: 20 })` → POST the list (`chatId`, `name`) to the backend to cache.
- **Backend**: `GET /api/messaging/groups` returns the cached list; `POST /api/witnesses/:id/link {chatId}` sets `witness.chatId` directly (replaces `request-link`).
- **Dashboard** (`WitnessCard.tsx`): the "link chat" button opens a **picker** listing real group names → choose → linked. Show a hint when the list is empty ("create the group in Messages first, with the bot's Apple Account in it").
- **Retire**: `linkRequestedAt`, `linkError`, the `/link-requests` endpoints, `TEMPLATE.witness_welcome` auto-send on create (make the welcome a normal outbox message the user approves, or drop it — they're hand-sending the recruitment message anyway). Keep the `inviteCode` + JOIN path as a fallback only if it costs nothing; otherwise delete it — the picker supersedes it.

## Phase C — deployment: the daemon moves to the Mac

Today `dream-messenger` is a systemd unit on the Linux VM. **The kit cannot run there** — it needs macOS + Messages.app. This is where the architecture pays off: the daemon already talks to the backend purely over HTTP.

- Backend stays on the VM. Daemon runs on the Mac with `BACKEND_URL=http://100.48.129.170:3001`.
- Replace the systemd unit with a **launchd plist** (`~/Library/LaunchAgents/codes.dream.messenger.plist`, `KeepAlive=true`, `RunAtLoad=true`) so it survives reboots/logout-login of that user session.
- `scripts/deploy-messenger.sh` no longer rsyncs to the VM — it becomes a local install/reload (`launchctl bootout/bootstrap`).
- **Security note:** the VM backend is public HTTP with no auth (SPEC A8 accepted this on a trusted network). A daemon polling it from the Mac over the open internet widens that. Either keep both on Tailscale, or add a shared-secret header on `/api/messaging/*`. **Decide before going live.**

## Phase D — verify

1. `bun test` in backend (90 tests must stay green — none of them touch the wire; the inbound-routing suite already covers JOIN/mute/less/more/evidence with a fake transport).
2. Daemon boots on the Mac, `listChats` returns the real group, dashboard picker shows it, linking sets `chatId`.
3. Approve a composed `random_prompt` → it lands in the **group**; friend and user both see it from the bot's identity (third voice intact).
4. Friend texts `less` in the group → cadence drops (proves `participant` → `senderHandle` routing).
5. User replies substantively in the group → captured as `goalEvidence`; a short "ok" is not.
6. Quiet hours still hold (it parked correctly at 02:12 ET during the cloud probe).

## Risks / open questions

- **The Apple Account/Mac requirement is the real cost** — it's not money, it's an always-on machine and a second identity. If that's untenable, the honest fallback is Business at $250/mo or the DM-per-friend design (works on free cloud today, but you're not in the chat).
- **AppleScript send fragility**: no delivery receipt, silent failures possible. `onFromMeMessage` confirmation is the mitigation if it bites.
- **Blue vs green**: if the friend isn't on iMessage the group degrades to SMS/MMS and the kit's behavior is not dependable. iMessage-only participants.
- **chat.db schema drift** across macOS versions is the kit's standing risk; pin the version and test after OS updates.
- **Mac asleep** = no sends until it wakes; the outbox queues safely (rows stay `approved`), so nothing is lost — just delayed. Disable sleep on that Mac.
