import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  schema,
  migrations,
  migrateSchema,
  type Migration,
} from "@/chat/conversations/sql/migrations";
import type { JuniorSqlMigrationExecutor } from "@/chat/sql/db";

class FakeSqlExecutor implements JuniorSqlMigrationExecutor {
  readonly locks: string[] = [];
  readonly statements: string[] = [];
  readonly transactions: string[][] = [];
  private readonly applied = new Map<string, string>();
  private activeTransaction: string[] | undefined;

  constructor(applied?: Iterable<readonly [string, string]>) {
    if (applied) {
      this.applied = new Map(applied);
    }
  }

  db(): never {
    throw new Error("Fake migration executor does not support Drizzle queries");
  }

  async execute(statement: string, params: readonly unknown[] = []) {
    const normalized = statement.trim();
    this.statements.push(normalized);
    this.activeTransaction?.push(normalized);
    if (normalized.startsWith("INSERT INTO junior_schema_migrations")) {
      this.applied.set(String(params[0]), String(params[1]));
    }
  }

  async query<T = unknown>(statement: string): Promise<T[]> {
    const normalized = statement.trim();
    this.statements.push(normalized);
    if (
      normalized ===
      "SELECT id, checksum FROM junior_schema_migrations ORDER BY id ASC"
    ) {
      return [...this.applied.entries()].map(([id, checksum]) => ({
        id,
        checksum,
      })) as T[];
    }
    throw new Error(`Unexpected query: ${statement}`);
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const statements: string[] = [];
    this.transactions.push(statements);
    this.activeTransaction = statements;
    try {
      return await callback();
    } finally {
      this.activeTransaction = undefined;
    }
  }

  async withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T> {
    this.locks.push(lockName);
    return await callback();
  }
}

describe("conversation SQL migrations", () => {
  it("runs pending migrations under the schema lock", async () => {
    const executor = new FakeSqlExecutor();

    await migrateSchema(executor);

    expect(executor.locks).toEqual(["junior_conversation_schema"]);
    expect(executor.statements[0]).toContain(
      "CREATE TABLE IF NOT EXISTS junior_schema_migrations",
    );
    expect(executor.transactions).toHaveLength(3);
    expect(executor.transactions[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS junior_identities"),
        expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS junior_destinations",
        ),
        expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS junior_conversations",
        ),
        expect.stringContaining("INSERT INTO junior_schema_migrations"),
      ]),
    );
    expect(executor.transactions[2]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS junior_users"),
        expect.stringContaining(
          "ALTER TABLE junior_identities\n  ADD COLUMN IF NOT EXISTS user_id",
        ),
        expect.stringContaining("INSERT INTO junior_users"),
        expect.stringContaining("UPDATE junior_identities AS identity"),
        expect.stringContaining("INSERT INTO junior_schema_migrations"),
      ]),
    );
  });

  it("does not reapply migrations already recorded with the same checksum", async () => {
    const executor = new FakeSqlExecutor(
      migrations.map((migration) => [migration.id, migration.checksum]),
    );

    await migrateSchema(executor);

    expect(executor.transactions).toHaveLength(0);
    expect(
      executor.statements.filter((statement) =>
        statement.startsWith("INSERT INTO junior_schema_migrations"),
      ),
    ).toHaveLength(0);
  });

  it("fails when an applied migration checksum has changed", async () => {
    const migration = migrations[0];
    const executor = new FakeSqlExecutor([[migration.id, "old-checksum"]]);

    await expect(migrateSchema(executor)).rejects.toThrow(
      `Conversation migration ${migration.id} checksum changed`,
    );
  });

  it("keeps transcript and mailbox authorities out of the SQL schema", () => {
    const ddl = migrations
      .flatMap((migration: Migration) => [
        migration.id,
        ...migration.statements,
      ])
      .join("\n");

    expect(ddl).not.toContain("thread-state");
    expect(ddl).not.toContain("agent-session-log");
    expect(ddl).not.toContain("inbound_messages");
    expect(ddl).not.toContain("lease_");
    expect(ddl).not.toMatch(/\btranscript\b/i);
  });

  it("exports Drizzle table definitions for the SQL schema", () => {
    expect(Object.values(schema).map((table) => getTableName(table))).toEqual([
      "junior_conversations",
      "junior_destinations",
      "junior_identities",
      "junior_schema_migrations",
      "junior_users",
    ]);
  });
});
