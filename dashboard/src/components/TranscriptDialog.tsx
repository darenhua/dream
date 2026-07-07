import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Conversation, Item } from "../data";

interface TranscriptDialogProps {
  item: Item | null;
  conversations: Conversation[];
  onClose: () => void;
}

export function TranscriptDialog({ item, conversations, onClose }: TranscriptDialogProps) {
  const sources = (item?.sources ?? [])
    .map(id => conversations.find(c => c.id === id))
    .filter((c): c is Conversation => Boolean(c));

  return (
    <Dialog open={item !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="pr-6">{item?.text}</DialogTitle>
          <DialogDescription>
            Derived from {sources.length} conversation{sources.length === 1 ? "" : "s"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6 overflow-y-auto">
          {sources.map(conversation => (
            <section key={conversation.id} className="flex flex-col gap-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                {conversation.date} · {conversation.title}
              </h3>
              {conversation.transcript?.length ? (
                <ol className="flex flex-col gap-2">
                  {conversation.transcript.map((message, i) => (
                    <li
                      key={i}
                      className={cn(
                        "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                        message.role === "user"
                          ? "self-end bg-primary text-primary-foreground"
                          : "self-start bg-muted",
                      )}
                    >
                      {message.text}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
                  No transcript available for this conversation.
                </p>
              )}
            </section>
          ))}
          {sources.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              No source conversations recorded for this item.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
