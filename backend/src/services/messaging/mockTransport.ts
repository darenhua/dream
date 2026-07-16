import type { ChatTransport, InboundEvent } from "./transport";

// The mock wire: accepts sends and hands back a fake transport id. It emits
// nothing — the outbound_message row IS the log (status/sentAt/
// transportMessageId), and markSent already writes the outbound_sent event.
// Inbound can be simulated through simulateInbound (admin/test hook).

export function createMockTransport(): ChatTransport & {
  simulateInbound: (e: InboundEvent) => Promise<void>;
} {
  let onInbound: ((e: InboundEvent) => Promise<void>) | null = null;
  return {
    platform: "mock",
    async start(handler) {
      onInbound = handler;
    },
    async stop() {
      onInbound = null;
    },
    async sendText(_chatId, _text) {
      return { messageId: `mock-${crypto.randomUUID()}` };
    },
    async simulateInbound(e) {
      if (!onInbound) throw new Error("mock transport not started");
      await onInbound(e);
    },
  };
}
