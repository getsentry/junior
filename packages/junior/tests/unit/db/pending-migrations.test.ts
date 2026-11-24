import { describe, expect, it } from "vitest";
import { pendingMigrations, type MigrationRecord } from "@/db/migrate";

// Times as Drizzle 0.x reads them from the journal (milliseconds).
const migrations = ["a", "b", "c", "d"].map((hash, index) => ({
  bps: true,
  folderMillis: (index + 1) * 10_000 + 123,
  hash,
  // Drizzle v1 adds the folder name.
  name: hash,
  sql: [],
}));
const [a, b, c, d] = migrations;
const row = (migration: (typeof migrations)[number]): MigrationRecord => ({
  createdAt: migration.folderMillis,
  hash: migration.hash,
});

describe("pending migrations", () => {
  it.each([
    { name: "a new database", records: [], pending: [a, b, c, d] },
    {
      name: "a migration merged after a newer one",
      records: [row(a!), row(c!)],
      pending: [b, d],
    },
    {
      name: "a migration whose time moved",
      records: [row(a!), { ...row(b!), createdAt: 15_000 }],
      pending: [c, d],
    },
    {
      name: "a legacy schema that recorded only its newest migration",
      records: [row(c!)],
      pending: [d],
    },
    {
      name: "a row of a newer release",
      records: [row(a!), { createdAt: 90_000, hash: "newer" }],
      pending: [b, c, d],
    },
  ])("records only applied migrations for $name", ({ records, pending }) => {
    expect(pendingMigrations(migrations, records)).toEqual(pending);
  });

  // Drizzle v1 reads the time from the folder name, to the second. A row
  // from 0.x has milliseconds, and its hash can be from before an SQL edit.
  it("matches a 0.x row to its Drizzle v1 migration", () => {
    const v1 = migrations.map((migration) => ({
      ...migration,
      folderMillis: Math.floor(migration.folderMillis / 1000) * 1000,
      hash: `${migration.hash}-edited`,
    }));
    expect(pendingMigrations(v1, migrations.slice(0, 3).map(row))).toEqual([
      v1[3],
    ]);
  });
});
