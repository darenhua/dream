import { useEffect, useState } from "react";
import { Sprout, Check } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type ExperimentRow, type WriteupRow } from "@/lib/api";

// The trajectory: the append-only queue of ended experiments (+ demoted
// writeup history).
export function HistoryPanel({ refreshKey }: { refreshKey: number }) {
  const [experiments, setExperiments] = useState<ExperimentRow[]>([]);
  const [writeups, setWriteups] = useState<WriteupRow[]>([]);

  useEffect(() => {
    api.experimentHistory().then(setExperiments).catch(() => setExperiments([]));
    api.writeupHistory().then(setWriteups).catch(() => setWriteups([]));
  }, [refreshKey]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">experiment history</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {experiments.map(e => (
              <li key={e.id} className="rounded-lg border px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  {e.status === "succeeded" ? <Check className="size-4 text-green-600" /> : <Sprout className="size-4 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {e.status} · {e.endedAt?.slice(0, 10) ?? "?"}
                  </span>
                </div>
                {e.outcomeMd && <p className="mt-1 text-xs text-muted-foreground">{e.outcomeMd}</p>}
              </li>
            ))}
            {experiments.length === 0 && (
              <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
                No finished experiments yet.
              </li>
            )}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">writeup history</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {writeups.map(w => (
              <li key={w.date} className="rounded-lg border px-3 py-2 text-sm">
                <p className="text-xs font-medium text-muted-foreground">{w.date}</p>
                <p className="line-clamp-3 text-xs italic">{w.text}</p>
              </li>
            ))}
            {writeups.length === 0 && (
              <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
                No writeups yet — run the daily job.
              </li>
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
