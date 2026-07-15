import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// The tripwire, in daylight: computed clocks, pause control, and the tunable
// knobs. Renegotiation happens here — never by quietly ignoring it.
export function StrikesSection({
  refreshKey,
  onChanged,
}: {
  refreshKey: number;
  onChanged: () => void | Promise<void>;
}) {
  const { data } = useApiData(() => api.vitals(), [refreshKey]);
  const [rantDays, setRantDays] = useState(3);
  const [threshold, setThreshold] = useState(3);
  const [nudgeDay, setNudgeDay] = useState(5);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [pauseDays, setPauseDays] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.config().then(cfg => {
      if (cfg.STRIKE_RANT_DAYS != null) setRantDays(Number(cfg.STRIKE_RANT_DAYS));
      if (cfg.STRIKE_THRESHOLD != null) setThreshold(Number(cfg.STRIKE_THRESHOLD));
      if (cfg.EXPERIMENT_QUEUE_NUDGE_DAY != null) setNudgeDay(Number(cfg.EXPERIMENT_QUEUE_NUDGE_DAY));
      setAlertsEnabled(cfg.STRIKE_ALERTS_ENABLED === true);
    });
  }, []);

  const save = async () => {
    await api.patchConfig({
      STRIKE_RANT_DAYS: rantDays,
      STRIKE_THRESHOLD: threshold,
      EXPERIMENT_QUEUE_NUDGE_DAY: nudgeDay,
      STRIKE_ALERTS_ENABLED: alertsEnabled,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await onChanged();
  };

  const s = data?.strikes;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">strikes (derived — nothing stored)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {s && (
          <p className="rounded-lg border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">
            total {s.total} = rant {s.rantStrikes} + queue {s.queueStrikes}
            {s.facts.daysSinceLastRant !== null && ` · ${s.facts.daysSinceLastRant}d since last rant`}
            {s.facts.emptyQueueDays > 0 && ` · queue empty ${s.facts.emptyQueueDays}d`}
            {` · ${s.armed ? "armed" : "alert already sent this episode"}`}
            {s.paused && ` · PAUSED until ${s.pausedUntil} (${s.pauseReason ?? "no reason"})`}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted-foreground">1 strike per</span>
          <Input type="number" className="w-16" value={rantDays} onChange={e => setRantDays(Number(e.target.value))} />
          <span className="text-muted-foreground">rant-quiet days · alert at</span>
          <Input type="number" className="w-16" value={threshold} onChange={e => setThreshold(Number(e.target.value))} />
          <span className="text-muted-foreground">strikes · nudge on day</span>
          <Input type="number" className="w-16" value={nudgeDay} onChange={e => setNudgeDay(Number(e.target.value))} />
        </div>

        <div className="flex items-center gap-2">
          <Switch id="strike-alerts" checked={alertsEnabled} onCheckedChange={setAlertsEnabled} />
          <Label htmlFor="strike-alerts">
            alerts live {alertsEnabled ? "(a linked primary witness will be messaged)" : "(dark: counting only)"}
          </Label>
          <Button size="sm" variant="outline" onClick={save}>
            {saved ? "saved ✓" : "save"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {s?.paused ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await api.resumeStrikes();
                await onChanged();
              }}
            >
              resume now
            </Button>
          ) : (
            <>
              <Input
                type="number"
                placeholder="days"
                className="w-20"
                value={pauseDays}
                onChange={e => setPauseDays(e.target.value)}
              />
              <Input
                placeholder="reason (traveling…)"
                className="w-48"
                value={pauseReason}
                onChange={e => setPauseReason(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!Number(pauseDays)}
                onClick={async () => {
                  await api.pauseStrikes(Number(pauseDays), pauseReason || undefined);
                  setPauseDays("");
                  setPauseReason("");
                  await onChanged();
                }}
              >
                pause
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
