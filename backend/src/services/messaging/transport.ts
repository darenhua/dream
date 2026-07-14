// The wire abstraction. Everything above this interface is transport-agnostic:
// the mock proves timing + content end-to-end before any real messaging
// platform exists, and swapping Photon/Telegram in later is one new file.

export interface InboundEvent {
  chatId: string; // transport-native chat GUID
  senderHandle: string; // phone/email of the sender
  text: string;
  sentAt: string; // ISO
  messageId: string; // transport-native id, for dedupe
}

export interface ChatTransport {
  readonly platform: "mock" | "imessage" | "telegram";
  start(onInbound: (e: InboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<{ messageId: string }>;
  createGroup?(handles: string[]): Promise<{ chatId: string }>;
}
