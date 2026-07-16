import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrations } from "../src/journal";

const temporaryDirectories: string[] = [];

async function migrationFolder(entries: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "junior-migrations-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "meta"));
  await writeFile(
    join(root, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((tag, index) => ({
        idx: index,
        version: "7",
        when: 1_000 + index,
        tag,
        breakpoints: true,
      })),
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveMigrations", () => {
  it("resolves one ordered SQL or TypeScript file per journal entry", async () => {
    const folder = await migrationFolder(["0000_initial", "0001_backfill"]);
    await writeFile(join(folder, "0000_initial.sql"), "SELECT 1;");
    await writeFile(
      join(folder, "0001_backfill.ts"),
      'import type { MigrationV1 } from "@sentry/junior-migrations";\nexport default { apiVersion: 1, async up() {} } satisfies MigrationV1;\n',
    );

    await expect(resolveMigrations(folder)).resolves.toMatchObject([
      { index: 0, kind: "sql", tag: "0000_initial", when: 1_000 },
      { index: 1, kind: "typescript", tag: "0001_backfill", when: 1_001 },
    ]);
  });

  it("rejects migrations that import runtime modules", async () => {
    const folder = await migrationFolder(["0000_unsafe"]);
    await writeFile(
      join(folder, "0000_unsafe.ts"),
      'import { getDb } from "@/db";\nexport default { apiVersion: 1, async up() { getDb(); } };\n',
    );

    await expect(resolveMigrations(folder)).rejects.toThrow(
      "cannot import application runtime code",
    );
  });

  it("rejects multiline imports of Junior runtime modules", async () => {
    const folder = await migrationFolder(["0000_multiline"]);
    await writeFile(
      join(folder, "0000_multiline.ts"),
      'import {\n  getChatConfig,\n  getDb,\n} from "@sentry/junior/internal";\nexport default { apiVersion: 1, async up() {} };\n',
    );

    await expect(resolveMigrations(folder)).rejects.toThrow(
      "cannot import application runtime code",
    );
  });

  it("allows versioned Junior migration helpers", async () => {
    const folder = await migrationFolder(["0000_helpers"]);
    await writeFile(
      join(folder, "0000_helpers.ts"),
      'import { isRecord } from "@sentry/junior/migration-helpers/v1";\nexport default { apiVersion: 1, async up() { isRecord({}); } };\n',
    );

    await expect(resolveMigrations(folder)).resolves.toMatchObject([
      { kind: "typescript", tag: "0000_helpers" },
    ]);
  });

  it("rejects runtime re-exports of Junior internals", async () => {
    const folder = await migrationFolder(["0000_reexport"]);
    await writeFile(
      join(folder, "0000_reexport.ts"),
      'export { getChatConfig } from "@sentry/junior/internal";\nexport default { apiVersion: 1, async up() {} };\n',
    );

    await expect(resolveMigrations(folder)).rejects.toThrow(
      "cannot import application runtime code",
    );
  });

  it("rejects ambiguous migration files", async () => {
    const folder = await migrationFolder(["0000_ambiguous"]);
    await writeFile(join(folder, "0000_ambiguous.sql"), "SELECT 1;");
    await writeFile(
      join(folder, "0000_ambiguous.ts"),
      "export default { apiVersion: 1, async up() {} };\n",
    );

    await expect(resolveMigrations(folder)).rejects.toThrow(
      "exactly one .sql or .ts file",
    );
  });

  it("rejects journal tags that escape the migration directory", async () => {
    const folder = await migrationFolder(["../outside"]);

    await expect(resolveMigrations(folder)).rejects.toThrow(
      "Invalid Drizzle journal entry",
    );
  });

  it("rejects symlinked migration sources", async () => {
    const folder = await migrationFolder(["0000_symlink"]);
    const outside = join(folder, "..", "outside-migration.ts");
    await writeFile(
      outside,
      "export default { apiVersion: 1, async up() {} };\n",
    );
    await symlink(outside, join(folder, "0000_symlink.ts"));

    await expect(resolveMigrations(folder)).rejects.toThrow(
      "Migration source must be a regular file",
    );
  });
});
