import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkDrizzleMigrationDirectory,
  drizzleKitCheckErrors,
} from "./check-drizzle-migrations.mjs";

function migrationFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-check-"));
  const folder = path.join(directory, "20260101000000_initial");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "migration.sql"), "SELECT 1;\n");
  fs.writeFileSync(path.join(folder, "snapshot.json"), "{}\n");
  return directory;
}

test("accepts migration folders with SQL and a snapshot", () => {
  const directory = migrationFixture();
  try {
    assert.deepEqual(checkDrizzleMigrationDirectory(directory), []);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("reports old layouts, stray files, and missing files", () => {
  const directory = migrationFixture();
  try {
    fs.mkdirSync(path.join(directory, "meta"));
    fs.writeFileSync(path.join(directory, "0001_next.sql"), "SELECT 2;\n");
    fs.rmSync(path.join(directory, "20260101000000_initial", "snapshot.json"));
    assert.deepEqual(checkDrizzleMigrationDirectory(directory).sort(), [
      `${path.join(directory, "0001_next.sql")}: a migration must be a folder named YYYYMMDDHHMMSS_name. Run \`pnpm db:generate\` to write one.`,
      `${path.join(directory, "20260101000000_initial", "snapshot.json")}: file is missing`,
      `${path.join(directory, "meta")}: Drizzle v1 does not read migrations/meta. Run \`drizzle-kit up\`.`,
    ]);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("reports drizzle-kit check conflicts and warnings", () => {
  assert.deepEqual(
    drizzleKitCheckErrors("packages/example", {
      stdout: '{"status":"ok","dialect":"postgresql"}\n',
      stderr: "",
    }),
    [],
  );
  assert.deepEqual(
    drizzleKitCheckErrors("packages/example", {
      stdout: JSON.stringify({
        status: "ok",
        warnings: [{ kind: "schema_changed", message: "Schema differs." }],
      }),
      stderr: "",
    }),
    ["packages/example: Schema differs."],
  );
  assert.deepEqual(
    drizzleKitCheckErrors("packages/example", {
      stdout: '{"status":"error","error":{"kind":"conflicts"}}\n',
      stderr: "Conflicting migrations detected\n",
    }),
    [
      "packages/example: drizzle-kit check failed:\nConflicting migrations detected",
    ],
  );
});
