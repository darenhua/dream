import { useState } from "react";
import { ArrowLeft, Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { L3Chat } from "@/components/L3Chat";
import { api } from "@/lib/api";

// Shape-the-next-experiment: a rant-like L3 dig, in-app. Finish feeds the
// transcript into the normal pipeline (already accepted — you chose to have
// this conversation); cancel leaves nothing behind.
export function ShapingChat({
  sessionId,
  onDone,
  onCancel,
}: {
  sessionId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState<"finish" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setBusy("finish");
    setError(null);
    try {
      await api.finishShaping(sessionId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    await api.cancelShaping(sessionId).catch(() => {});
    onCancel();
  };

  return (
    <div className="flex h-[80vh] flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={cancel} disabled={busy !== null}>
          <ArrowLeft className="size-4" /> discard
        </Button>
        <h2 className="text-lg font-semibold">shaping the next experiment</h2>
        <Button size="sm" onClick={finish} disabled={busy !== null}>
          {busy === "finish" ? <Loader2 className="animate-spin" /> : <Check />} finish — feed it in
        </Button>
      </header>
      {error && <p className="rounded-lg border border-destructive px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 rounded-xl border">
        <L3Chat sessionId={sessionId} />
      </div>
    </div>
  );
}
