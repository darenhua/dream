import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Send, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type ChatSessionRow, type SchedulePlan } from "@/lib/api";
import { cn } from "@/lib/utils";

// The scheduling conversation: the backend agent proposes concrete times from
// your real free time; push back in chat until it feels right, then commit.
export function ScheduleChat({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const [session, setSession] = useState<ChatSessionRow | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = () => api.chatSession(sessionId).then(setSession).catch(e => setError(String(e)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.chatSend(sessionId, text.trim());
      setSession(updated);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.chatConfirm(sessionId);
      if (!result.ok) {
        setError(result.error ?? "commit failed");
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await api.chatCancel(sessionId).catch(() => {});
    onDone();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          <ArrowLeft className="size-4" /> back (keeps the session)
        </Button>
        <h2 className="font-medium">scheduling the experiment</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>
            <X className="size-3" /> return to queue
          </Button>
          <Button size="sm" disabled={busy || !session?.plan} onClick={confirm}>
            <Check className="size-3" /> commit — start running
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        {/* chat */}
        <Card className="md:col-span-3">
          <CardContent className="flex h-[60vh] flex-col gap-2 overflow-y-auto py-4">
            {(session?.messages ?? []).map(m => (
              <div
                key={m.id}
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                  m.role === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted",
                )}
              >
                {m.content}
              </div>
            ))}
            {!session?.messages.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                the agent is drafting an opening plan from your free time…
              </p>
            )}
            {busy && <p className="self-start text-xs text-muted-foreground">thinking…</p>}
            <div ref={bottomRef} />
          </CardContent>
          <div className="flex gap-2 border-t p-3">
            <Textarea
              className="min-h-10"
              placeholder="push back: wrong time, too much, wrong lever…"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Button disabled={busy || !text.trim()} onClick={send}>
              <Send className="size-4" />
            </Button>
          </div>
        </Card>

        {/* live plan */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">the plan so far</CardTitle>
          </CardHeader>
          <CardContent>
            {session?.plan ? <PlanPreview plan={session.plan} /> : (
              <p className="text-sm text-muted-foreground">no plan drafted yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PlanPreview({ plan }: { plan: SchedulePlan }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">{plan.hypothesis_md}</p>
      <div className="flex gap-2">
        <Badge variant="outline">~{plan.planned_duration_days} days</Badge>
        <Badge variant="outline">bandwidth: {plan.bandwidth}</Badge>
      </div>
      {plan.habit_blocks.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">new habit blocks</h4>
          <ul className="flex flex-col gap-1">
            {plan.habit_blocks.map((h, i) => (
              <li key={i} className="rounded border border-orange-300 bg-orange-50 px-2 py-1 dark:border-orange-800 dark:bg-orange-950">
                {h.title}
                <span className="ml-1 text-xs text-muted-foreground">
                  {h.preferred_time} · {h.duration_minutes}m · {h.rrule.replace("FREQ=", "").toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.tasks.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">one-offs</h4>
          <ul className="flex flex-col gap-1">
            {plan.tasks.map((t, i) => (
              <li key={i} className="rounded border px-2 py-1">
                {t.title}
                <span className="ml-1 text-xs text-muted-foreground">
                  {t.kind} · {t.start.slice(5, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
