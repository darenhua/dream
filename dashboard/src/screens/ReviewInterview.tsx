import { useState } from "react";
import { ArrowLeft, Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { L3Chat } from "@/components/L3Chat";
import { api } from "@/lib/api";

// The optional review interview: a short L3 conversation (3–4 pointed
// questions) whose transcript regenerates the writeup draft on finish.
export function ReviewInterview({
  sessionId,
  onDone,
  onBack,
}: {
  sessionId: string;
  onDone: () => void; // finish → draft regenerated → back to the review screen
  onBack: () => void; // leave without regenerating
}) {
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      await api.finishReviewInterview(sessionId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFinishing(false);
    }
  };

  return (
    <div className="flex h-[80vh] flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={finishing}>
          <ArrowLeft className="size-4" /> back
        </Button>
        <h2 className="text-lg font-semibold">how did it actually go?</h2>
        <Button size="sm" onClick={finish} disabled={finishing}>
          {finishing ? <Loader2 className="animate-spin" /> : <Check />} finish — rewrite the draft
        </Button>
      </header>
      {error && <p className="rounded-lg border border-destructive px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 rounded-xl border">
        <L3Chat sessionId={sessionId} />
      </div>
    </div>
  );
}
