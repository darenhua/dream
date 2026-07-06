import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Item } from "../data";

interface CategoryCardProps {
  title: string;
  items: Item[];
  onEdit: () => void;
  className?: string;
}

export function ItemPill({ item }: { item: Item }) {
  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        item.active
          ? "border-green-300 bg-green-200/70 dark:border-green-800 dark:bg-green-900/40"
          : "bg-card",
      )}
    >
      {item.text}
    </li>
  );
}

export function CategoryCard({ title, items, onEdit, className }: CategoryCardProps) {
  return (
    <Card className={cn("gap-3 py-4", className)}>
      <CardHeader className="px-4">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center">
          <span aria-hidden />
          <CardTitle className="text-center text-base font-medium">{title}</CardTitle>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 justify-self-end"
            onClick={onEdit}
            aria-label={`Edit ${title}`}
          >
            <Pencil />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4">
        <ul className="flex flex-col gap-2">
          {items.map(item => (
            <ItemPill key={item.id} item={item} />
          ))}
          {items.length === 0 && (
            <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
              No items
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
