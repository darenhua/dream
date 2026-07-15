import { useState } from "react";
import { ArrowLeft, Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { L3Chat } from "@/components/L3Chat";
import { api } from "@/lib/api";

const LABEL: Record<string, { title: string; finish: string }> = {
  distill: { title: "steering the extraction pass", finish: "finish — redo the pass" },
  proposal: { title: "steering this proposal", finish: "finish — regenerate it" },
  goal: { title: "steering this goal's record", finish: "finish — apply the rewrite" },
};

// The universal EDIT conversation: shared across every steer target. The chat
// knows the original generation (instructions, inputs, output); finishing
// re-runs it with this conversation as steering and replaces the artifact
// in place. Discard leaves everything untouched.
export function SteerChat({
  sessionId,
  targetType,
  onDone,
  onCancel,
}: {
  sessionId: string;
  targetType: "distill" | "proposal" | "goal";
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState<"finish" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = LABEL[targetType] ?? LABEL.distill!;

  const finish = async () => {
    setBusy("finish");
    setError(null);
    try {
      await api.finishSteer(sessionId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    await api.cancelSteer(sessionId).catch(() => {});
    onCancel();
  };

  return (
    <div className="flex h-[80vh] flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={cancel} disabled={busy !== null}>
          <ArrowLeft className="size-4" /> discard
        </Button>
        <h2 className="text-lg font-semibold">{label.title}</h2>
        <Button size="sm" onClick={finish} disabled={busy !== null}>
          {busy === "finish" ? <Loader2 className="animate-spin" /> : <Check />} {label.finish}
        </Button>
      </header>
      {error && <p className="rounded-lg border border-destructive px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 rounded-xl border">
        <L3Chat sessionId={sessionId} />
      </div>
    </div>
  );
}
