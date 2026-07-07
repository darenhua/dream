import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Check, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Item } from "../data";

interface ProposedTableProps {
  items: Item[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onRowClick: (item: Item) => void;
}

export function ProposedTable({ items, onAccept, onReject, onRowClick }: ProposedTableProps) {
  const columns: ColumnDef<Item>[] = [
    {
      accessorKey: "text",
      header: "Proposed item",
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-2">
          <span>{row.original.text}</span>
          {row.original.category && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {row.original.category}
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        // stopPropagation keeps Accept/Reject clicks from also opening the transcript dialog
        <div className="flex justify-end gap-2" onClick={e => e.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => onAccept(row.original.id)}>
            <Check /> Accept
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onReject(row.original.id)}>
            <X /> Reject
          </Button>
        </div>
      ),
    },
  ];

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map(headerGroup => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map(header => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map(row => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => onRowClick(row.original)}
              >
                {row.getVisibleCells().map(cell => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
                Nothing left to review.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
