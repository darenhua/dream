import { useEffect, useState } from "react";
import { ArrowLeft, Check, Loader2, MessagesSquare, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type WitnessRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// The review moment: an agent-drafted writeup the user edits and approves.
// Approval is what fans out per-witness goal-filtered shares into the outbox
// — nothing reaches a friend from here directly.
export function ReviewWriteup({
  experimentId,
  onOpenInterview,
  onBack,
}: {
  experimentId: string;
  onOpenInterview: (sessionId: string) => void;
  onBack: () => void;
}) {
  const [tick, setTick] = useState(0);
  const { data: review, error } = useApiData(() => api.review(experimentId).catch(() => null), [tick]);
  const { data: witnesses } = useApiData(() => api.witnesses(), []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [shares, setShares] = useState<Record<string, string> | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (review?.draftMd != null && review.status === "draft_ready") setDraft(review.draftMd);
  }, [review?.id, review?.status]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setToast(null);
    try {
      await fn();
      setTick(t => t + 1);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const witnessName = (id: string) => witnesses?.find(w => w.id === id)?.name ?? id;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> feed
        </Button>
        <h2 className="text-lg font-semibold">experiment review</h2>
      </header>

      {toast && <p className="rounded-lg border border-destructive px-3 py-2 text-sm text-destructive">{toast}</p>}

      {!review || review.status === "drafting" ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 px-4 py-6">
            <p className="text-sm text-muted-foreground">
              {review ? "the draft is still being written (or the drafter died mid-flight)." : "no draft yet."}
            </p>
            <Button disabled={busy !== null} onClick={() => act("generate", () => api.generateReview(experimentId))}>
              {busy === "generate" ? <Loader2 className="animate-spin" /> : <RefreshCw />} generate draft
            </Button>
          </CardContent>
        </Card>
      ) : review.status === "approved" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">approved ✓</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="whitespace-pre-wrap text-sm">{review.finalMd}</p>
            <p className="text-xs text-muted-foreground">
              shares for each witness are in the outbox on the feed — approve them there to send.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">the writeup — your words, your call</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={16}
                className="font-mono text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy !== null || !draft.trim()}
                  onClick={() =>
                    act("approve", async () => {
                      const result = await api.approveReview(experimentId, draft);
                      setShares(result.shares);
                    })
                  }
                >
                  {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} approve — compose witness shares
                </Button>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    act("interview", async () => {
                      const { sessionId } = await api.startReviewInterview(experimentId);
                      onOpenInterview(sessionId);
                    })
                  }
                >
                  {busy === "interview" ? <Loader2 className="animate-spin" /> : <MessagesSquare />} flesh out via chat
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => act("save", () => api.patchReview(experimentId, draft))}
                >
                  {busy === "save" ? <Loader2 className="animate-spin" /> : null} save draft
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => act("regen", () => api.generateReview(experimentId))}
                >
                  {busy === "regen" ? <Loader2 className="animate-spin" /> : <RefreshCw />} regenerate
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {shares && Object.keys(shares).length > 0 && (
        <Card className="border-emerald-300 dark:border-emerald-800">
          <CardHeader>
            <CardTitle className="text-base font-medium">composed for each witness (pending in the outbox)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {Object.entries(shares).map(([witnessId, body]) => (
              <div key={witnessId} className="rounded-lg border px-3 py-2 text-sm">
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">{witnessName(witnessId)}</p>
                <p className="whitespace-pre-wrap">{body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {shares && Object.keys(shares).length === 0 && (
        <p className="text-sm text-muted-foreground">
          no witness is scoped to this experiment's goals — the review stays private.
        </p>
      )}
      {error && !review && <p className="text-sm text-muted-foreground">{error}</p>}
    </div>
  );
}
