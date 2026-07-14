import { ArrowUp, Loader2 } from "lucide-react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";

import { Button } from "@/components/ui/button";
import { api, type ChatMessageRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// The one L3 conversation surface (review interview, experiment shaping, …):
// assistant-ui primitives over the AI SDK runtime, streaming from
// POST /api/l3/sessions/:id/stream. The server persists both turns itself —
// the client is a pure view.

function UserMessage() {
  return (
    <MessagePrimitive.Root className="max-w-[85%] self-end rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function ChatThread({ sessionId, initial, readOnly }: { sessionId: string; initial: ChatMessageRow[]; readOnly: boolean }) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: `/api/l3/sessions/${sessionId}/stream` }),
    messages: initial.map(m => ({
      id: m.id,
      role: m.role,
      parts: [{ type: "text" as const, text: m.content }],
    })),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <ThreadPrimitive.Empty>
            <p className="text-center text-sm text-muted-foreground">say what's on your mind — messy is fine</p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        {!readOnly && (
          <ComposerPrimitive.Root className="flex items-end gap-2 border-t p-3">
            <ComposerPrimitive.Input
              autoFocus
              placeholder="type — enter to send"
              className="max-h-40 flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              rows={1}
            />
            <ComposerPrimitive.Send asChild>
              <Button size="icon">
                <ArrowUp className="size-4" />
              </Button>
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        )}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export function L3Chat({ sessionId, readOnly = false }: { sessionId: string; readOnly?: boolean }) {
  // Initial history must exist before the runtime is created, so gate on it.
  const { data, error } = useApiData(() => api.l3Session(sessionId), [sessionId]);
  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <ChatThread sessionId={sessionId} initial={data.messages} readOnly={readOnly || data.session.status !== "open"} />;
}
