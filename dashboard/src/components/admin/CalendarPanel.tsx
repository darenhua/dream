import { useState } from "react";
import { CalendarCheck, ExternalLink, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// Google Calendar connection: consent URL + manual code-paste fallback, sync
// state, and a sync-now button.
export function CalendarPanel({ refreshKey }: { refreshKey: number }) {
  const [tick, setTick] = useState(0);
  const { data: status } = useApiData(() => api.calendarStatus(), [refreshKey, tick]);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      setMessage(`${label}: ${JSON.stringify(result).slice(0, 160)}`);
      setTick(t => t + 1);
    } catch (e) {
      setMessage(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <CalendarCheck className="size-4" /> google calendar
          </CardTitle>
          <Badge variant={status?.connected ? "default" : "outline"}>
            {status?.connected ? "connected" : "not connected"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {status?.connected ? (
          <>
            <p className="text-xs text-muted-foreground">
              dream calendar: <span className="font-mono">{status.dreamCalendarId ?? "(created on first push)"}</span>
              {" · "}sync token: {status.hasSyncToken ? "✓" : "none yet"}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => act(api.calendarSync, "sync")}>
                <RefreshCw className="size-3" /> sync now
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              one click: consent opens in a new tab and the server finishes the rest. remote setup
              (VM) where localhost can't reach the server: let the redirect fail, copy the{" "}
              <span className="font-mono">code</span> param from its URL, paste it below.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                  try {
                    const { url } = await api.calendarAuthUrl();
                    window.open(url, "_blank");
                  } catch (e) {
                    setMessage(`consent url failed: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
              >
                <ExternalLink className="size-3" /> connect google calendar
              </Button>
              <Input
                placeholder="paste authorization code"
                value={code}
                onChange={e => setCode(e.target.value)}
                className="max-w-xs"
              />
              <Button
                size="sm"
                disabled={busy || !code.trim()}
                onClick={() => act(() => api.calendarAuthToken(code.trim()), "connect")}
              >
                connect
              </Button>
            </div>
          </>
        )}
        {message && <p className="font-mono text-xs text-muted-foreground">{message}</p>}
      </CardContent>
    </Card>
  );
}
