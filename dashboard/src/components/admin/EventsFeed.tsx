import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type EventRow } from "@/lib/api";

// Tier 3: the append-only trajectory (§7.11), newest first.
export function EventsFeed({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<EventRow[]>([]);

  const load = () => api.events(50).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
  }, [refreshKey]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">events</CardTitle>
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {rows.map(e => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50">
              <span className="font-mono text-muted-foreground">{e.createdAt.slice(5, 16).replace("T", " ")}</span>
              <span className="font-medium">{e.eventType}</span>
              <span className="text-muted-foreground">{e.entityType}</span>
              {e.payloadJson && e.payloadJson !== "{}" && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{e.payloadJson}</span>
              )}
            </li>
          ))}
          {rows.length === 0 && (
            <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
              No events yet.
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
