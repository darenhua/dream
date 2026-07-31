import { sql } from "drizzle-orm";
import type { DreamDb } from "../index";

// Data migrations: backfills/inserts that need domain logic (TS), as opposed
// to DDL and plain-SQL backfills which belong in drizzle/ migrations. Each
// entry runs exactly once per database — at boot, right after the drizzle
// migrator — inside a transaction, tracked by name in the data_migration
// table. Append-only registry: never edit, rename, or reorder an entry that
// has shipped; write a new one. Files live beside this index as
// NNNN_name.ts (export a DataMigration) and are registered here explicitly.
export type DataMigration = {
  name: string; // "NNNN_short_slug", unique forever
  run: (db: DreamDb) => void;
};

const MIGRATIONS: DataMigration[] = [
  // { name: "0001_example", run: ... } ← import from ./0001_example.ts
];

export function runDataMigrations(db: DreamDb) {
  db.run(sql`CREATE TABLE IF NOT EXISTS data_migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const seen = new Set<string>();
  for (const migration of MIGRATIONS) {
    if (seen.has(migration.name)) throw new Error(`duplicate data migration name: ${migration.name}`);
    seen.add(migration.name);
    const applied = db.get(sql`SELECT name FROM data_migration WHERE name = ${migration.name}`);
    if (applied) continue;
    db.transaction(tx => {
      migration.run(tx as unknown as DreamDb);
      tx.run(
        sql`INSERT INTO data_migration (name, applied_at) VALUES (${migration.name}, ${new Date().toISOString()})`,
      );
    });
  }
}
