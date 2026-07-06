import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { Item } from "../data";

interface EditSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: Item[];
  accepted: Item[];
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
}

export function EditSheet({
  open,
  onOpenChange,
  title,
  items,
  accepted,
  onRemove,
  onAdd,
}: EditSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit {title}</SheetTitle>
          <SheetDescription>
            Remove items with the X, or add them back from the list below.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6">
          <ul className="flex flex-col gap-2">
            {items.map(item => (
              <li
                key={item.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg border py-1 pl-3 pr-1 text-sm",
                  item.active &&
                    "border-green-300 bg-green-200/70 dark:border-green-800 dark:bg-green-900/40",
                )}
              >
                <span className="py-1">{item.text}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove ${item.text}`}
                >
                  <X />
                </Button>
              </li>
            ))}
            {items.length === 0 && (
              <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
                No items
              </li>
            )}
          </ul>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-muted-foreground">proposed and accepted</p>
            <ul className="flex flex-col gap-2">
              {accepted.map(item => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded-lg border py-1 pl-3 pr-1 text-sm"
                >
                  <span className="py-1">{item.text}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    onClick={() => onAdd(item.id)}
                    aria-label={`Add ${item.text}`}
                  >
                    <Plus />
                  </Button>
                </li>
              ))}
              {accepted.length === 0 && (
                <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
                  Nothing accepted yet
                </li>
              )}
            </ul>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
