import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

// Hard delete exists only here (spec N7): wipe everything, then re-seed config.
export function DangerZone({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.reset();
      await api.seedConfig();
      setResult("database wiped and config re-seeded — a blank garden");
      setConfirm("");
      await onChanged();
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium text-destructive">
          <TriangleAlert className="size-4" /> danger zone
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Wipes every table (conversations, goals, registries, experiments, proposals, events) and
          re-seeds default config. This is the §11.1 cold-start step — nothing else in the app
          deletes anything.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder='type "RESET" to arm'
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            className="sm:max-w-48"
          />
          <Button variant="destructive" disabled={confirm !== "RESET" || busy} onClick={reset}>
            wipe database + re-seed config
          </Button>
        </div>
        {result && <p className="text-xs text-muted-foreground">{result}</p>}
      </CardContent>
    </Card>
  );
}
