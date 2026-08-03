import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDrizzleMigrationDirectory } from "./check-drizzle-migrations.mjs";

function migrationFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-check-"));
  fs.mkdirSync(path.join(directory, "meta"));
  fs.writeFileSync(path.join(directory, "0000_initial.sql"), "SELECT 1;\n");
  fs.writeFileSync(
    path.join(directory, "meta", "_journal.json"),
    JSON.stringify({ entries: [{ idx: 0, tag: "0000_initial" }] }),
  );
  fs.writeFileSync(
    path.join(directory, "meta", "0000_snapshot.json"),
    JSON.stringify({
      id: "snapshot-0",
      prevId: "00000000-0000-0000-0000-000000000000",
    }),
  );
  return directory;
}

test("accepts matching migration SQL, journal, and snapshot metadata", () => {
  const directory = migrationFixture();
  try {
    assert.deepEqual(checkDrizzleMigrationDirectory(directory), []);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("reports missing and orphaned migration files", () => {
  const directory = migrationFixture();
  try {
    fs.rmSync(path.join(directory, "meta", "0000_snapshot.json"));
    fs.writeFileSync(path.join(directory, "0001_orphan.sql"), "SELECT 2;\n");
    assert.deepEqual(checkDrizzleMigrationDirectory(directory), [
      `${path.join(directory, "meta", "0000_snapshot.json")}: migration snapshot is missing`,
      `${path.join(directory, "0001_orphan.sql")}: migration SQL is not in the journal`,
    ]);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("reports a broken snapshot chain", () => {
  const directory = migrationFixture();
  try {
    fs.writeFileSync(path.join(directory, "0001_next.sql"), "SELECT 2;\n");
    fs.writeFileSync(
      path.join(directory, "meta", "_journal.json"),
      JSON.stringify({
        entries: [
          { idx: 0, tag: "0000_initial" },
          { idx: 1, tag: "0001_next" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(directory, "meta", "0001_snapshot.json"),
      JSON.stringify({ id: "snapshot-1", prevId: "wrong-id" }),
    );
    assert.deepEqual(checkDrizzleMigrationDirectory(directory), [
      `${path.join(directory, "meta", "0001_snapshot.json")}: prevId must match the previous snapshot id snapshot-0`,
    ]);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
