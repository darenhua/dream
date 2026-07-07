import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Item, TranscriptMessage } from "../data";

interface TranscriptDialogProps {
  item: Item | null;
  onClose: () => void;
}

interface SourceTranscript {
  id: string;
  title: string;
  date: string;
  transcript: TranscriptMessage[];
}

export function TranscriptDialog({ item, onClose }: TranscriptDialogProps) {
  const [sources, setSources] = useState<SourceTranscript[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item?.sources?.length) {
      setSources([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      item.sources.map(async id => {
        const convo = await api.conversation(id);
        return {
          id,
          title: convo.title ?? "(untitled)",
          date: (convo.sourceUpdatedAt ?? "").slice(0, 10),
          transcript: (convo.messages ?? []).map(m => ({
            role: m.role === "user" ? ("user" as const) : ("coach" as const),
            text: m.content,
          })),
        };
      }),
    )
      .then(result => {
        if (!cancelled) setSources(result);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  return (
    <Dialog open={item !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="pr-6">{item?.text}</DialogTitle>
          <DialogDescription>
            {loading
              ? "Loading source conversations…"
              : `Derived from ${sources.length} conversation${sources.length === 1 ? "" : "s"}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6 overflow-y-auto">
          {sources.map(conversation => (
            <section key={conversation.id} className="flex flex-col gap-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                {conversation.date} · {conversation.title}
              </h3>
              {conversation.transcript.length ? (
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
          {!loading && sources.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              No source conversations recorded for this item.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
