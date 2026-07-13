import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface Window {
  start: string;
  end: string;
}

// Sleep/work window defaults — the anchors override these day by day.
export function AnchorConfig({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [sleep, setSleep] = useState<Window>({ start: "23:30", end: "07:30" });
  const [work, setWork] = useState<Window & { days: number[] }>({ start: "09:30", end: "18:00", days: [1, 2, 3, 4, 5] });
  const [timezone, setTimezone] = useState("America/New_York");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.config().then(cfg => {
      if (cfg.SLEEP_WINDOW) setSleep(cfg.SLEEP_WINDOW as Window);
      if (cfg.WORK_WINDOW) setWork(cfg.WORK_WINDOW as Window & { days: number[] });
      if (cfg.TIMEZONE) setTimezone(cfg.TIMEZONE as string);
    });
  }, []);

  const save = async () => {
    await api.patchConfig({ SLEEP_WINDOW: sleep, WORK_WINDOW: work, TIMEZONE: timezone });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await onChanged();
  };

  const timeInput = (value: string, set: (v: string) => void) => (
    <Input type="time" className="w-28" value={value} onChange={e => set(e.target.value)} />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">day windows (free time = the rest)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-16 text-muted-foreground">sleep</span>
          {timeInput(sleep.start, v => setSleep(s => ({ ...s, start: v })))}
          <span className="text-muted-foreground">→</span>
          {timeInput(sleep.end, v => setSleep(s => ({ ...s, end: v })))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-16 text-muted-foreground">work</span>
          {timeInput(work.start, v => setWork(w => ({ ...w, start: v })))}
          <span className="text-muted-foreground">→</span>
          {timeInput(work.end, v => setWork(w => ({ ...w, end: v })))}
          <div className="flex gap-1">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <button
                key={i}
                className={
                  "size-7 rounded-full border text-xs " +
                  (work.days.includes(i) ? "bg-primary text-primary-foreground" : "text-muted-foreground")
                }
                onClick={() =>
                  setWork(w => ({
                    ...w,
                    days: w.days.includes(i) ? w.days.filter(x => x !== i) : [...w.days, i].sort(),
                  }))
                }
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-16 text-muted-foreground">timezone</span>
          <Input className="max-w-xs" value={timezone} onChange={e => setTimezone(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" className="self-start" onClick={save}>
          {saved ? "saved ✓" : "save windows"}
        </Button>
      </CardContent>
    </Card>
  );
}
