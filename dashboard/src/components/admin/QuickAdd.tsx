import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type CategoryRow } from "@/lib/api";

interface QuickAddProps {
  categories: CategoryRow[];
  onChanged: () => void | Promise<void>;
}

// §11.5–11.6 seeding, in the UI: manual goals + registry items.
export function QuickAdd({ categories, onChanged }: QuickAddProps) {
  const [goalTitle, setGoalTitle] = useState("");
  const [identityClause, setIdentityClause] = useState("");
  const [goalCategory, setGoalCategory] = useState<string>("none");
  const [regKind, setRegKind] = useState<"habit" | "environment" | "experience">("habit");
  const [regTitle, setRegTitle] = useState("");
  const [regValence, setRegValence] = useState<"good" | "bad" | "none">("none");
  const [note, setNote] = useState<string | null>(null);

  const submitGoal = async () => {
    if (!goalTitle.trim()) return;
    const result = await api.createGoal({
      title: goalTitle.trim(),
      identityClause: identityClause.trim() || undefined,
      categoryId: goalCategory === "none" ? null : goalCategory,
    });
    setNote(result.note ?? `goal "${result.goal.title}" created (${result.goal.status})`);
    setGoalTitle("");
    setIdentityClause("");
    await onChanged();
  };

  const submitRegistry = async () => {
    if (!regTitle.trim()) return;
    await api.createRegistry({
      kind: regKind,
      title: regTitle.trim(),
      valence: regKind === "habit" && regValence !== "none" ? regValence : undefined,
    });
    setNote(`${regKind} "${regTitle.trim()}" added`);
    setRegTitle("");
    setRegValence("none");
    await onChanged();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">quick add</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">manual goal (origin: manual)</p>
          <div className="flex flex-col gap-2 lg:flex-row">
            <Input placeholder="title" value={goalTitle} onChange={e => setGoalTitle(e.target.value)} className="lg:max-w-56" />
            <Input
              placeholder='identity clause: "I am becoming someone who…"'
              value={identityClause}
              onChange={e => setIdentityClause(e.target.value)}
              className="flex-1"
            />
            <Select value={goalCategory} onValueChange={setGoalCategory}>
              <SelectTrigger className="lg:w-44">
                <SelectValue placeholder="category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">no category</SelectItem>
                {categories.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={submitGoal} disabled={!goalTitle.trim()}>
              <Plus /> goal
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">manual registry item</p>
          <div className="flex flex-col gap-2 lg:flex-row">
            <Select value={regKind} onValueChange={v => setRegKind(v as typeof regKind)}>
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="habit">habit</SelectItem>
                <SelectItem value="environment">environment</SelectItem>
                <SelectItem value="experience">experience</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder="title" value={regTitle} onChange={e => setRegTitle(e.target.value)} className="flex-1" />
            {regKind === "habit" && (
              <Select value={regValence} onValueChange={v => setRegValence(v as typeof regValence)}>
                <SelectTrigger className="lg:w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">no valence</SelectItem>
                  <SelectItem value="good">good</SelectItem>
                  <SelectItem value="bad">bad</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" onClick={submitRegistry} disabled={!regTitle.trim()}>
              <Plus /> {regKind}
            </Button>
          </div>
        </div>

        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}
