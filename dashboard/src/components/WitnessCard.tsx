import { Eye, Link2, Loader2, Star, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type WitnessRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<WitnessRow["status"], string> = {
  invited: "bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  active: "bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  paused: "bg-muted text-muted-foreground",
  removed: "bg-muted text-muted-foreground",
};

// The witness registry: friends who see only the goals you scope them to.
// The seat is the feature; the invite is a seat with a code on it. The
// recruitment message itself stays yours to write — rep #1 of asking.
export function WitnessCard({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data: witnesses } = useApiData(() => api.witnesses(), [tick]);
  const { data: goals } = useApiData(() => api.goals(), [tick]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<WitnessRow | null>(null);
  const [preview, setPreview] = useState<{ name: string; md: string } | null>(null);
  const [linking, setLinking] = useState<WitnessRow | null>(null);

  const goalTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of goals ?? []) m.set(g.id, g.title);
    return m;
  }, [goals]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base font-medium">witnesses</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-4" /> invite a friend
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {(witnesses ?? []).length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
            nobody's watching yet — accountability starts with one friend seeing your weekly rhythm
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {(witnesses ?? []).map(w => (
            <li key={w.id} className="flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                {w.isPrimary && <Star className="size-4 fill-amber-400 text-amber-400" />}
                <button className="font-medium hover:underline" onClick={() => setEditing(w)}>
                  {w.name}
                </button>
                <Badge className={cn("border-transparent", STATUS_STYLE[w.status])}>{w.status}</Badge>
                {w.status === "invited" && w.inviteCode && (
                  <span className="font-mono text-xs text-muted-foreground">code {w.inviteCode}</span>
                )}
                {w.chatId ? (
                  <Badge
                    variant="outline"
                    className="cursor-pointer text-xs text-emerald-700 dark:text-emerald-300"
                    title="click to unlink"
                    onClick={async () => {
                      await api.unlinkWitnessChat(w.id).catch(() => {});
                      onChanged();
                    }}
                  >
                    <Link2 className="mr-1 size-3" /> chat linked
                  </Badge>
                ) : (
                  <Button size="sm" variant="ghost" className="text-xs" onClick={() => setLinking(w)}>
                    <Link2 className="size-3" /> link chat
                  </Button>
                )}
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  title="what this friend can see"
                  onClick={async () => {
                    const p = await api.witnessPreview(w.id);
                    setPreview({ name: w.name, md: p.contextMd });
                  }}
                >
                  <Eye className="size-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {w.goalIds.length === 0 && (
                  <span className="text-xs text-muted-foreground">no goals shared — sees nothing</span>
                )}
                {w.goalIds.map(g => (
                  <Badge key={g} variant="outline" className="text-xs">
                    {goalTitle.get(g) ?? "…"}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>

      <WitnessDialog
        open={inviteOpen || editing !== null}
        witness={editing}
        goals={goals ?? []}
        onClose={() => {
          setInviteOpen(false);
          setEditing(null);
        }}
        onChanged={onChanged}
      />

      <GroupPickerDialog
        witness={linking}
        onClose={() => setLinking(null)}
        onChanged={onChanged}
      />

      <Dialog open={preview !== null} onOpenChange={open => !open && setPreview(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>what {preview?.name} can see</DialogTitle>
          </DialogHeader>
          <pre className="whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs">{preview?.md}</pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// The local iMessage kit can't create groups (and group chatIds encode
// Messages.app internals, so they're never constructed) — you make the group
// by hand in Messages, then pick it here.
function GroupPickerDialog({
  witness,
  onClose,
  onChanged,
}: {
  witness: WitnessRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tick, setTick] = useState(0);
  const { data, error } = useApiData(
    () => (witness ? api.messengerGroups() : Promise.resolve(null)),
    [witness?.id, tick],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const groups = (data?.groups ?? []).filter(g => !g.isArchived);

  return (
    <Dialog open={witness !== null} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>which chat is {witness?.name} in?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Create the group in Messages first — you, {witness?.name}, and the bot's Apple Account — then pick it
            here. The messenger daemon on your always-on Mac publishes this list.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {data?.publishedAt === null && (
            <p className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
              no groups published yet — is the messenger daemon running on the Mac?
            </p>
          )}
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {groups.map(g => (
              <li key={g.chatId}>
                <button
                  disabled={busy !== null}
                  className="w-full rounded-lg border px-3 py-2 text-left hover:bg-muted"
                  onClick={async () => {
                    if (!witness) return;
                    setBusy(g.chatId);
                    try {
                      await api.linkWitnessChat(witness.id, g.chatId);
                      onChanged();
                      onClose();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <span className="font-medium">{g.name ?? "(unnamed group)"}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{g.chatId.slice(0, 24)}…</span>
                </button>
              </li>
            ))}
            {data && groups.length === 0 && data.publishedAt !== null && (
              <li className="rounded-lg border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
                no group chats found in Messages
              </li>
            )}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setTick(t => t + 1)}>
              refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WitnessDialog({
  open,
  witness,
  goals,
  onClose,
  onChanged,
}: {
  open: boolean;
  witness: WitnessRow | null;
  goals: { id: string; title: string; status: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [isPrimary, setIsPrimary] = useState(false);
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seed form state when the dialog opens for a specific witness (or fresh).
  const key = witness?.id ?? "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setName(witness?.name ?? "");
    setHandle(witness?.handle ?? "");
    setTimezone(witness?.timezone ?? "America/New_York");
    setIsPrimary(witness?.isPrimary ?? false);
    setGoalIds(witness?.goalIds ?? []);
  }
  if (!open && seeded !== null) setSeeded(null);

  const toggleGoal = (id: string) =>
    setGoalIds(ids => (ids.includes(id) ? ids.filter(g => g !== id) : [...ids, id]));

  const save = async () => {
    setBusy(true);
    try {
      if (witness) {
        await api.patchWitness(witness.id, { name, handle, timezone });
        await api.setWitnessGoals(witness.id, goalIds);
        if (isPrimary && !witness.isPrimary) await api.setWitnessPrimary(witness.id);
      } else {
        await api.inviteWitness({ name, handle, timezone, isPrimary, goalIds });
      }
      onChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{witness ? `edit ${witness.name}` : "invite a friend"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex gap-2">
            <Input placeholder="name" value={name} onChange={e => setName(e.target.value)} />
            <Input placeholder="phone / handle" value={handle} onChange={e => setHandle(e.target.value)} />
          </div>
          <Input placeholder="timezone" value={timezone} onChange={e => setTimezone(e.target.value)} />

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              which goals do they get to know about?
            </span>
            <div className="flex flex-wrap gap-1">
              {goals.map(g => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => toggleGoal(g.id)}
                  className={cn(
                    "rounded-full border px-2 py-1 text-xs",
                    goalIds.includes(g.id)
                      ? "border-emerald-400 bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
                      : "text-muted-foreground",
                  )}
                >
                  {g.title}
                </button>
              ))}
              {goals.length === 0 && (
                <span className="text-xs text-muted-foreground">no goals yet — they'll see nothing until you scope them</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch id="primary-witness" checked={isPrimary} onCheckedChange={setIsPrimary} />
            <Label htmlFor="primary-witness" className="text-sm">
              primary — the friend the strike alert goes to
            </Label>
          </div>

          {witness?.status === "invited" && witness.inviteCode && (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
              chat-link code: <span className="font-mono">{witness.inviteCode}</span> — used later when the
              iMessage agent joins. The recruitment message is yours to send.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              cancel
            </Button>
            <Button disabled={!name.trim() || busy} onClick={save}>
              {witness ? "save" : "create invite"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
