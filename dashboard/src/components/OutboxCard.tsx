import { useState } from "react";
import { Check, Copy, Send, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type OutboundRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

const KIND_LABEL: Record<OutboundRow["kind"], string> = {
  review_share: "review share",
  experiment_announcement: "announcement",
  random_prompt: "conversation ammo",
  strike_alert: "strike alert",
  duty_ping: "duty ping",
};

// The approval gate, visible: every agent-composed message to a friend waits
// here. Approve sends (mock/linked transport) — copy is the manual protocol:
// paste it into iMessage yourself.
export function OutboxCard({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data: pending } = useApiData(() => api.outbox("pending_approval"), [tick]);
  const { data: witnesses } = useApiData(() => api.witnesses(), [tick]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  if (!pending || pending.length === 0) return null;
  const witnessName = (id: string) => witnesses?.find(w => w.id === id)?.name ?? "?";

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
    <Card className="border-sky-300 dark:border-sky-800">
      <CardContent className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Send className="size-4" />
          {pending.length} message{pending.length === 1 ? "" : "s"} waiting for your approval
        </div>
        <ul className="flex flex-col gap-2">
          {pending.map(row => (
            <li key={row.id} className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{witnessName(row.witnessId)}</span>
                <Badge variant="outline">{KIND_LABEL[row.kind]}</Badge>
                {row.notBefore && (
                  <span className="text-xs text-muted-foreground">not before {row.notBefore.slice(5, 16)}</span>
                )}
              </div>
              {editing === row.id ? (
                <Textarea value={editText} onChange={e => setEditText(e.target.value)} rows={4} />
              ) : (
                <p className="whitespace-pre-wrap text-muted-foreground">{row.bodyText}</p>
              )}
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === row.id}
                  onClick={() =>
                    act(row.id, () => api.approveOutbound(row.id, editing === row.id ? editText : undefined))
                  }
                >
                  <Check className="size-3" /> approve + send
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (editing === row.id) {
                      setEditing(null);
                    } else {
                      setEditing(row.id);
                      setEditText(row.bodyText);
                    }
                  }}
                >
                  {editing === row.id ? "discard edit" : "edit"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await navigator.clipboard.writeText(editing === row.id ? editText : row.bodyText);
                    setCopied(row.id);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  <Copy className="size-3" /> {copied === row.id ? "copied ✓" : "copy"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={busy === row.id}
                  onClick={() => act(row.id, () => api.cancelOutbound(row.id))}
                >
                  <X className="size-3" /> cancel
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
