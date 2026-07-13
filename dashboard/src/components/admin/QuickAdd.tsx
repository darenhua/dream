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
import { api } from "@/lib/api";

// Cold-start seeding: manually create goals / habits / environment /
// experiences without waiting for rants to derive them.
export function QuickAdd({ onChanged }: { onChanged: () => void | Promise<void> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">quick add (manual seeding)</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GoalForm onChanged={onChanged} />
        <RegistryForm onChanged={onChanged} />
      </CardContent>
    </Card>
  );
}

function GoalForm({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [title, setTitle] = useState("");
  const [identityClause, setIdentityClause] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) return;
    const result = await api.createGoal({
      title: title.trim(),
      identityClause: identityClause.trim() || undefined,
    });
    setNote(result.note ?? null);
    setTitle("");
    setIdentityClause("");
    await onChanged();
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase text-muted-foreground">goal</p>
      <Input placeholder="title" value={title} onChange={e => setTitle(e.target.value)} />
      <Input
        placeholder='identity clause — "I am becoming someone who…"'
        value={identityClause}
        onChange={e => setIdentityClause(e.target.value)}
      />
      <Button variant="outline" size="sm" disabled={!title.trim()} onClick={submit}>
        <Plus /> add goal
      </Button>
      {note && <p className="text-xs text-amber-700 dark:text-amber-400">{note}</p>}
    </div>
  );
}

const KINDS = [
  { value: "habit-good", label: "habit (good)" },
  { value: "habit-bad", label: "habit (bad)" },
  { value: "environment-physical_setup", label: "environment: setup" },
  { value: "environment-obligation", label: "environment: obligation" },
  { value: "environment-social", label: "environment: social" },
  { value: "experience-had", label: "experience (had)" },
  { value: "experience-planned", label: "experience (planned)" },
];

function RegistryForm({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [kind, setKind] = useState("habit-good");
  const [title, setTitle] = useState("");
  const [noteText, setNoteText] = useState("");

  const submit = async () => {
    if (!title.trim()) return;
    const note = noteText.trim() || undefined;
    const [table, variant] = kind.split("-") as [string, string];
    if (table === "habit") {
      await api.createHabit({ title: title.trim(), note, valence: variant });
    } else if (table === "environment") {
      await api.createEnvironment({ title: title.trim(), note, subKind: variant });
    } else {
      await api.createExperience({ title: title.trim(), note, state: variant });
    }
    setTitle("");
    setNoteText("");
    await onChanged();
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase text-muted-foreground">habit / environment / experience</p>
      <Select value={kind} onValueChange={setKind}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {KINDS.map(k => (
            <SelectItem key={k.value} value={k.value}>
              {k.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input placeholder="title" value={title} onChange={e => setTitle(e.target.value)} />
      <Input placeholder="note (optional)" value={noteText} onChange={e => setNoteText(e.target.value)} />
      <Button variant="outline" size="sm" disabled={!title.trim()} onClick={submit}>
        <Plus /> add
      </Button>
    </div>
  );
}
