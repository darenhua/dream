import { useEffect, useState } from "react";
import { Archive, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, type CategoryRow } from "@/lib/api";

type Row = CategoryRow & { topKOverride: number | null };

export function CategoriesManager({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () => api.allCategories().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">categories</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={e => {
            e.preventDefault();
            if (!name.trim()) return;
            act(() => api.createCategory({ name: name.trim(), description: description.trim() || undefined }));
            setName("");
            setDescription("");
          }}
        >
          <Input placeholder="new category name" value={name} onChange={e => setName(e.target.value)} className="sm:max-w-48" />
          <Input placeholder="description (what keeps landing here?)" value={description} onChange={e => setDescription(e.target.value)} className="flex-1" />
          <Button type="submit" variant="outline" disabled={!name.trim()}>
            <Plus /> create
          </Button>
        </form>

        <ul className="flex flex-col gap-2">
          {rows.map(cat => (
            <li key={cat.id} className="flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <input
                  className="w-full bg-transparent text-sm font-medium outline-none"
                  defaultValue={cat.name}
                  disabled={cat.status === "archived"}
                  onBlur={e => {
                    const value = e.target.value.trim();
                    if (value && value !== cat.name) act(() => api.patchCategory(cat.id, { name: value }));
                  }}
                />
                <input
                  className="w-full bg-transparent text-xs text-muted-foreground outline-none"
                  defaultValue={cat.description ?? ""}
                  placeholder="add a description…"
                  disabled={cat.status === "archived"}
                  onBlur={e => {
                    const value = e.target.value.trim();
                    if (value !== (cat.description ?? "")) act(() => api.patchCategory(cat.id, { description: value }));
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                {cat.status === "archived" ? (
                  <Button variant="outline" size="sm" onClick={() => act(() => api.patchCategory(cat.id, { status: "active" }))}>
                    unarchive
                  </Button>
                ) : (
                  <>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      top-K
                      <Input
                        type="number"
                        min={1}
                        className="h-8 w-16 text-xs"
                        defaultValue={cat.topKOverride ?? ""}
                        placeholder="dflt"
                        onBlur={e => {
                          const raw = e.target.value.trim();
                          const next = raw === "" ? null : Number(raw);
                          if (next !== cat.topKOverride) act(() => api.patchCategory(cat.id, { topKOverride: next }));
                        }}
                      />
                    </label>
                    <Button variant="ghost" size="sm" onClick={() => act(() => api.patchCategory(cat.id, { status: "archived" }))}>
                      <Archive /> archive
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
              No categories yet — create the obvious ones, then link conversations to them.
            </li>
          )}
        </ul>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
