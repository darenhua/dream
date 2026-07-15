import { useState } from "react";
import { Check, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// The intake gate: imported chats the detector thinks are rants, waiting for
// a human yes/no. Accept starts distill; reject just files it away.
export function RantCandidatesGate({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data: candidates } = useApiData(() => api.conversations({ rant: "proposed" }), [tick]);
  const [busy, setBusy] = useState<string | null>(null);

  if (!candidates || candidates.length === 0) return null;

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="border-violet-300 dark:border-violet-800">
      <CardContent className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4" />
          {candidates.length} chat{candidates.length === 1 ? " looks" : "s look"} like a rant — yours to
          call
        </div>
        <ul className="flex flex-col gap-1">
          {candidates.map(c => (
            <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <span className="mr-2 font-mono text-xs text-muted-foreground">
                  {(c.sourceUpdatedAt ?? "").slice(5, 10)}
                </span>
                {c.title ?? "(untitled)"}
                {c.detectorNote && (
                  <span className="ml-2 text-xs text-muted-foreground">— {c.detectorNote}</span>
                )}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === c.id}
                  onClick={() => act(c.id, () => api.rantAccept(c.id))}
                >
                  <Check className="size-4" /> it's a rant
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === c.id}
                  onClick={() => act(c.id, () => api.rantReject(c.id))}
                >
                  <X className="size-4" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
