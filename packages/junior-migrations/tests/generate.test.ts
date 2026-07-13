import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { generateTypeScriptMigration } from "../src/generate";
import { readMigrationJournal } from "../src/journal";

const temporaryDirectories: string[] = [];

function runDrizzle(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("drizzle-kit", args, { cwd, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(output));
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("keeps Drizzle schema generation working across a TypeScript entry", async () => {
  const relativeRoot = `.tmp-mixed-migrations-${Date.now()}`;
  const root = join(process.cwd(), relativeRoot);
  temporaryDirectories.push(root);
  await mkdir(root);
  await writeFile(
    join(root, "schema.ts"),
    'import { pgTable, text } from "drizzle-orm/pg-core";\nexport const users = pgTable("users", { id: text("id").primaryKey() });\n',
  );
  await writeFile(
    join(root, "drizzle.config.ts"),
    `import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "postgresql", schema: "./${relativeRoot}/schema.ts", out: "./${relativeRoot}/migrations" });\n`,
  );

  await runDrizzle(
    [
      "generate",
      "--config",
      `${relativeRoot}/drizzle.config.ts`,
      "--name",
      "initial",
    ],
    process.cwd(),
  );
  const typescriptPath = await generateTypeScriptMigration({
    configPath: `${relativeRoot}/drizzle.config.ts`,
    cwd: process.cwd(),
    migrationsFolder: `${relativeRoot}/migrations`,
    name: "backfill",
  });
  await expect(access(typescriptPath)).resolves.toBeUndefined();
  await expect(
    access(join(root, "migrations", "0001_backfill.sql")),
  ).rejects.toThrow("ENOENT");

  await writeFile(
    join(root, "schema.ts"),
    'import { pgTable, text } from "drizzle-orm/pg-core";\nexport const users = pgTable("users", { id: text("id").primaryKey(), name: text("name") });\n',
  );
  await runDrizzle(
    [
      "generate",
      "--config",
      `${relativeRoot}/drizzle.config.ts`,
      "--name",
      "add_name",
    ],
    process.cwd(),
  );

  await expect(
    readMigrationJournal(join(root, "migrations")),
  ).resolves.toMatchObject([
    { index: 0, tag: "0000_initial" },
    { index: 1, tag: "0001_backfill" },
    { index: 2, tag: "0002_add_name" },
  ]);
  await expect(
    readFile(join(root, "migrations", "0002_add_name.sql"), "utf8"),
  ).resolves.toContain('ADD COLUMN "name" text');
});
