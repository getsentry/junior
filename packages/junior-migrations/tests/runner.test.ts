import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrationJournal } from "../src/runner";
import type {
  MigrationContextV1,
  MigrationDatabaseAdapter,
  MigrationV1,
} from "../src/types";

interface StoredRow {
  createdAt: number;
  hash: string;
  progress?: unknown;
  status: string | null;
}

class FakeExecutor implements MigrationDatabaseAdapter {
  readonly rows = new Map<number, StoredRow>();
  readonly statements: string[] = [];

  db(): undefined {
    return undefined;
  }

  async execute(statement: string, parameters: readonly unknown[] = []) {
    const normalized = statement.trim();
    if (
      normalized.startsWith("CREATE SCHEMA") ||
      normalized.startsWith("CREATE TABLE IF NOT EXISTS drizzle.") ||
      normalized.startsWith("ALTER TABLE drizzle.")
    ) {
      return;
    }
    if (normalized.startsWith("INSERT INTO drizzle.")) {
      const hash = String(parameters[0]);
      const createdAt = Number(parameters[1]);
      const kind = normalized.includes("'typescript'")
        ? "running"
        : "completed";
      this.rows.set(createdAt, { createdAt, hash, status: kind });
      return;
    }
    if (normalized.startsWith("UPDATE drizzle.")) {
      const createdAt = Number(parameters.at(-1));
      const row = this.rows.get(createdAt);
      if (!row) {
        throw new Error(`Missing row ${createdAt}`);
      }
      if (normalized.includes("progress = $1")) {
        row.progress = parameters[0];
      }
      if (normalized.includes("status = 'running'")) {
        row.status = "running";
      } else if (normalized.includes("status = 'completed'")) {
        row.status = "completed";
      } else if (normalized.includes("status = 'failed'")) {
        row.status = "failed";
      }
      return;
    }
    this.statements.push(normalized);
  }

  async query<T>(statement: string, parameters: readonly unknown[] = []) {
    if (statement.includes('created_at::text AS "createdAt"')) {
      return [...this.rows.values()].map((row) => ({
        createdAt: String(row.createdAt),
        hash: row.hash,
        progress: row.progress,
        status: row.status,
      })) as T[];
    }
    if (statement.includes("SELECT progress")) {
      const row = this.rows.get(Number(parameters[0]));
      return (row ? [{ progress: row.progress ?? null }] : []) as T[];
    }
    return [];
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    return await callback();
  }

  async withMigrationLock<T>(
    _migrationTable: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    return await callback();
  }

  async withLock<T>(_lockName: string, callback: () => Promise<T>): Promise<T> {
    return await callback();
  }
}

function fakeMigrationState(): MigrationContextV1["state"] {
  return {
    acquireLock: async () => null,
    appendToList: async () => {},
    connect: async () => {},
    delete: async () => {},
    get: async () => undefined,
    getList: async () => [],
    releaseLock: async () => {},
    set: async () => {},
    setIfNotExists: async () => true,
  };
}

const temporaryDirectories: string[] = [];

async function mixedFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "junior-migrations-runner-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "meta"));
  await writeFile(
    join(root, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: ["0000_schema", "0001_data", "0002_schema"].map(
        (tag, index) => ({
          idx: index,
          version: "7",
          when: 2_000 + index,
          tag,
          breakpoints: true,
        }),
      ),
    }),
  );
  await writeFile(join(root, "0000_schema.sql"), "SELECT 'schema-zero';");
  await writeFile(
    join(root, "0001_data.ts"),
    'import type { MigrationV1 } from "@sentry/junior-migrations";\nexport default {} satisfies MigrationV1;\n',
  );
  await writeFile(join(root, "0002_schema.sql"), "SELECT 'schema-two';");
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runMigrationJournal", () => {
  it("runs mixed entries in journal order and is a no-op on rerun", async () => {
    const folder = await mixedFolder();
    const executor = new FakeExecutor();
    const order: string[] = [];
    const migration: MigrationV1 = {
      apiVersion: 1,
      async up(context) {
        order.push("typescript");
        await context.progress.save({ cursor: 1 });
      },
    };

    await expect(
      runMigrationJournal({
        executor,
        migrationsFolder: folder,
        migrationsTable: "__drizzle_test",
        loadTypeScript: async () => ({ default: migration }),
        createContext: async ({ progress }) => ({
          log: () => {},
          progress,
          database: executor,
          state: fakeMigrationState(),
        }),
      }),
    ).resolves.toEqual({ existing: 0, migrated: 3, scanned: 3, skipped: 0 });
    expect(executor.statements).toEqual([
      "SELECT 'schema-zero';",
      "SELECT 'schema-two';",
    ]);
    expect(order).toEqual(["typescript"]);

    await expect(
      runMigrationJournal({
        executor,
        migrationsFolder: folder,
        migrationsTable: "__drizzle_test",
        loadTypeScript: async () => ({ default: migration }),
        createContext: ({ progress }) => ({
          log: () => {},
          progress,
          database: executor,
          state: fakeMigrationState(),
        }),
      }),
    ).resolves.toEqual({ existing: 3, migrated: 0, scanned: 3, skipped: 0 });
  });

  it("bootstraps the latest schema while leaving TypeScript entries pending", async () => {
    const folder = await mixedFolder();
    const executor = new FakeExecutor();

    await expect(
      runMigrationJournal({
        executor,
        migrationsFolder: folder,
        migrationsTable: "__drizzle_test",
        mode: "schema-bootstrap",
      }),
    ).resolves.toEqual({ existing: 0, migrated: 2, scanned: 3, skipped: 1 });
    expect([...executor.rows.keys()].sort()).toEqual([2_000, 2_002]);
    expect(executor.statements).toEqual([
      "SELECT 'schema-zero';",
      "SELECT 'schema-two';",
    ]);

    const migration: MigrationV1 = {
      apiVersion: 1,
      async up() {
        return { backfilled: true };
      },
    };
    await expect(
      runMigrationJournal({
        executor,
        migrationsFolder: folder,
        migrationsTable: "__drizzle_test",
        loadTypeScript: async () => ({ default: migration }),
        createContext: ({ progress }) => ({
          database: executor,
          log: () => {},
          progress,
          state: fakeMigrationState(),
        }),
      }),
    ).resolves.toEqual({ existing: 2, migrated: 1, scanned: 3, skipped: 0 });
    expect(executor.statements).toEqual([
      "SELECT 'schema-zero';",
      "SELECT 'schema-two';",
    ]);
  });

  it("resumes a failed TypeScript migration from saved progress", async () => {
    const folder = await mixedFolder();
    const executor = new FakeExecutor();
    let attempts = 0;
    const migration: MigrationV1 = {
      apiVersion: 1,
      async up(context) {
        attempts += 1;
        const progress = await context.progress.load();
        if (!progress) {
          await context.progress.save({ cursor: 1 });
          throw new Error("interrupted");
        }
        return { resumed: true };
      },
    };
    const options = {
      executor,
      migrationsFolder: folder,
      migrationsTable: "__drizzle_test",
      loadTypeScript: async () => ({ default: migration }),
      createContext: ({
        progress,
      }: {
        progress: MigrationContextV1["progress"];
      }) => ({
        log: () => {},
        progress,
        database: executor,
        state: fakeMigrationState(),
      }),
    };

    await expect(runMigrationJournal(options)).rejects.toThrow("interrupted");
    expect(executor.rows.get(2_001)).toMatchObject({
      progress: { cursor: 1 },
      status: "failed",
    });
    expect(executor.statements).toEqual(["SELECT 'schema-zero';"]);

    await expect(runMigrationJournal(options)).resolves.toEqual({
      existing: 1,
      migrated: 2,
      scanned: 3,
      skipped: 0,
    });
    expect(attempts).toBe(2);
    expect(executor.rows.get(2_001)).toMatchObject({
      progress: { cursor: 1 },
      status: "completed",
    });
    expect(executor.statements).toEqual([
      "SELECT 'schema-zero';",
      "SELECT 'schema-two';",
    ]);
  });

  it("rejects non-JSON migration results before completing the ledger row", async () => {
    const folder = await mixedFolder();
    const executor = new FakeExecutor();
    const migration = {
      apiVersion: 1,
      async up() {
        return Number.NaN as never;
      },
    } satisfies MigrationV1;

    await expect(
      runMigrationJournal({
        executor,
        migrationsFolder: folder,
        migrationsTable: "__drizzle_test",
        loadTypeScript: async () => ({ default: migration }),
        createContext: ({ progress }) => ({
          database: executor,
          log: () => {},
          progress,
          state: fakeMigrationState(),
        }),
      }),
    ).rejects.toThrow("Migration result must contain only finite JSON numbers");
    expect(executor.rows.get(2_001)?.status).toBe("failed");
  });
});
