import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, type RecordChangeSet, type RecordVerdict } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// The human-in-the-loop approvals page: every MCP-created change set lands
// here. The AI reconciliation pass suggests per-row verdicts (new / version
// bump / remix / link existing); the human confirms and applies atomically.
export function ReviewInbox({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: pending, refresh } = useApiData(() => api.reviewList("ready_for_review"), [tick]);
  const { data: recent } = useApiData(() => api.reviewList(), [tick]);

  const refreshAll = () => {
    refresh();
    onChanged();
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">awaiting your review ({pending?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {(pending ?? []).map(cs => (
            <button
              key={cs.id}
              className="flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => setOpenId(cs.id)}
            >
              <Badge className="border-transparent bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                {cs.operations.filter(op => op.op === "create").length} records
              </Badge>
              <span className="min-w-0 flex-1 truncate">{cs.summaryMd.split("\n")[0]}</span>
              <span className="font-mono text-xs text-muted-foreground">{cs.markerToken}</span>
            </button>
          ))}
          {(pending ?? []).length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              Nothing waiting. Run record_create in a Claude conversation and it lands here.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">history</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {(recent ?? [])
            .filter(cs => cs.status !== "ready_for_review")
            .slice(0, 15)
            .map(cs => (
              <div key={cs.id} className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm">
                <Badge variant="outline">{cs.status}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{cs.summaryMd.split("\n")[0]}</span>
              </div>
            ))}
        </CardContent>
      </Card>

      {openId && <ChangeSetDialog id={openId} onClose={() => setOpenId(null)} onChanged={refreshAll} />}
    </div>
  );
}

const VERDICT_LABEL: Record<string, string> = {
  new: "create new",
  version_bump: "version bump of…",
  link_existing: "link to existing…",
  remix: "remix (new, derived)",
};

function ChangeSetDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [verdicts, setVerdicts] = useState<Record<string, RecordVerdict>>({});
  const [refreshTick, setRefreshTick] = useState(0);
  const { data: cs } = useApiData(() => api.reviewGet(id), [refreshTick]);

  if (!cs) return null;
  const creates = cs.operations.filter(op => op.op === "create");
  const links = cs.operations.filter(op => op.op === "link");
  const candidatesFor = (tempId: string) => cs.reconciliation?.candidates?.[tempId] ?? [];
  const suggestedFor = (tempId: string) => cs.reconciliation?.verdicts?.[tempId];
  const currentVerdict = (tempId: string): RecordVerdict => verdicts[tempId] ?? suggestedFor(tempId) ?? { verdict: "new" };

  const act = async (name: string, fn: () => Promise<unknown>, close = true) => {
    setBusy(name);
    try {
      await fn();
      onChanged();
      if (close) onClose();
      else setRefreshTick(t => t + 1);
    } catch {
      /* surfaced by reload */
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>review change set</DialogTitle>
        </DialogHeader>

        <section className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm">{cs.summaryMd}</section>

        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">records to create</h3>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act("reconcile", () => api.reviewReconcile(cs.id), false)}>
            {busy === "reconcile" ? <Loader2 className="animate-spin" /> : <Sparkles />} run AI reconciliation
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          {creates.map(op => {
            const verdict = currentVerdict(op.tempId);
            const candidates = candidatesFor(op.tempId);
            const reason = cs.reconciliation?.reasons?.[op.tempId];
            return (
              <div key={op.tempId} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{op.model}</Badge>
                  {op.role === "central" && <Badge>central</Badge>}
                  <span className="font-medium">{String(op.fields.title ?? "")}</span>
                </div>
                {typeof op.fields.description === "string" && op.fields.description && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{op.fields.description}</p>
                )}
                {reason && <p className="mt-1 text-xs italic text-muted-foreground">AI: {reason}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    className="rounded-md border bg-background px-2 py-1 text-xs"
                    value={verdict.verdict}
                    onChange={e => {
                      const kind = e.target.value;
                      if (kind === "new") setVerdicts({ ...verdicts, [op.tempId]: { verdict: "new" } });
                      else if (kind === "version_bump")
                        setVerdicts({ ...verdicts, [op.tempId]: { verdict: "version_bump", ofLineageId: candidates[0]?.lineageId ?? "" } });
                      else if (kind === "link_existing")
                        setVerdicts({ ...verdicts, [op.tempId]: { verdict: "link_existing", lineageId: candidates[0]?.lineageId ?? "" } });
                    }}
                  >
                    {Object.entries(VERDICT_LABEL)
                      .filter(([k]) => k !== "remix")
                      .map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                  </select>
                  {(verdict.verdict === "version_bump" || verdict.verdict === "link_existing") && (
                    <select
                      className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
                      value={verdict.verdict === "version_bump" ? verdict.ofLineageId : verdict.lineageId}
                      onChange={e =>
                        setVerdicts({
                          ...verdicts,
                          [op.tempId]:
                            verdict.verdict === "version_bump"
                              ? { verdict: "version_bump", ofLineageId: e.target.value }
                              : { verdict: "link_existing", lineageId: e.target.value },
                        })
                      }
                    >
                      {candidates.map(c => (
                        <option key={c.lineageId} value={c.lineageId}>
                          {c.title} (v{c.version})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {candidates.length > 0 && verdict.verdict === "new" && (
                  <p className="mt-1 text-xs text-muted-foreground">similar: {candidates.map(c => c.title).join(" · ")}</p>
                )}
              </div>
            );
          })}
        </div>

        {links.length > 0 && (
          <div className="rounded-lg border p-3 text-xs text-muted-foreground">
            {links.map((op, i) => (
              <div key={i}>
                {op.relation}: {op.from} → {op.to}
                {op.description ? ` — ${op.description}` : ""}
              </div>
            ))}
          </div>
        )}

        <Textarea placeholder="feedback (for send back / reject)…" value={feedback} onChange={e => setFeedback(e.target.value)} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy !== null} onClick={() => act("reject", () => api.reviewReject(cs.id, feedback || undefined, false))}>
            reject
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => act("return", () => api.reviewReject(cs.id, feedback || undefined, true))}>
            send back with feedback
          </Button>
          <Button disabled={busy !== null} onClick={() => act("apply", () => api.reviewApply(cs.id, verdicts))}>
            {busy === "apply" && <Loader2 className="animate-spin" />} apply entire change set
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
