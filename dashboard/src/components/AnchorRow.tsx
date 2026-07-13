import { useState } from "react";
import { Briefcase, DoorOpen, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, type AnchorKind, type RescheduleDiff } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

const ANCHORS: { kind: AnchorKind; label: string; icon: typeof Sun }[] = [
  { kind: "wake_up", label: "i'm up", icon: Sun },
  { kind: "start_work", label: "at work", icon: Briefcase },
  { kind: "end_work", label: "off work", icon: DoorOpen },
  { kind: "sleep", label: "sleeping", icon: Moon },
];

// One-tap anchors: timestamp the day's real edges and blame-freely reshuffle
// today's remaining blocks around the new reality.
export function AnchorRow({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [busy, setBusy] = useState<AnchorKind | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { data: today } = useApiData(() => api.anchors(), [tick]);

  const tap = async (kind: AnchorKind) => {
    setBusy(kind);
    setToast(null);
    try {
      const { reschedule } = await api.tapAnchor(kind);
      setToast(describeDiff(reschedule));
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const tappedKinds = new Set((today ?? []).map(a => a.kind));

  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-4 gap-2">
        {ANCHORS.map(({ kind, label, icon: Icon }) => (
          <Button
            key={kind}
            variant={tappedKinds.has(kind) ? "secondary" : "outline"}
            className="h-12"
            disabled={busy !== null}
            onClick={() => tap(kind)}
          >
            <Icon className="size-4" />
            <span className="hidden sm:inline">{label}</span>
          </Button>
        ))}
      </div>
      {toast && <p className="text-center text-xs text-muted-foreground">{toast}</p>}
    </div>
  );
}

function describeDiff(diff: RescheduleDiff | null): string {
  if (!diff) return "noted.";
  const parts: string[] = [];
  if (diff.moved.length) {
    parts.push(diff.moved.map(m => `${m.title} → ${m.to}`).join(", "));
  }
  if (diff.unplaced.length) {
    parts.push(`${diff.unplaced.map(u => u.title).join(", ")} didn't fit today — no big deal`);
  }
  return parts.length ? `noted. ${parts.join(" · ")}` : "noted. nothing needed moving.";
}
