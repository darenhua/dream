import { emit } from "../events";
import type { ChatTransport, InboundEvent } from "./transport";

// The mock wire: every "delivery" is an append-only event row, inspectable in
// the admin EventsFeed — proving each message fires at the right time with
// the right content long before a real transport exists. Inbound can be
// simulated through handleInbound (admin/test hook).

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
    async sendText(chatId, text) {
      const messageId = `mock-${crypto.randomUUID()}`;
      emit("outbound_message", null, "mock_delivered", { chatId, text, messageId });
      return { messageId };
    },
    async simulateInbound(e) {
      if (!onInbound) throw new Error("mock transport not started");
      await onInbound(e);
    },
  };
}
