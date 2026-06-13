import { randomUUID } from "node:crypto";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

type PgliteQueryClient = PGlite | Transaction;

export interface LocalPgliteFixture<TDatabase> {
  client: PGlite;
  db(): TDatabase;
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  query<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class LocalPgliteExecutor<TDatabase> implements LocalPgliteFixture<TDatabase> {
  private activeTransaction: Transaction | undefined;

  constructor(
    readonly client: PGlite,
    private readonly schema: Record<string, unknown>,
  ) {}

  db(): TDatabase {
    return drizzle(this.queryClient() as PGlite, {
      schema: this.schema,
    }) as unknown as TDatabase;
  }

  async execute(
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<void> {
    if (params.length === 0) {
      await this.queryClient().exec(statement);
      return;
    }
    await this.queryClient().query(statement, [...params]);
  }

  async query<T = unknown>(
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.queryClient().query<T>(statement, [...params]);
    return result.rows as T[];
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    if (this.activeTransaction) {
      return await callback();
    }
    return await this.client.transaction(async (transaction) => {
      const previous = this.activeTransaction;
      this.activeTransaction = transaction;
      try {
        return await callback();
      } finally {
        this.activeTransaction = previous;
      }
    });
  }

  async withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T> {
    if (!lockName) {
      throw new Error("Migration lock name is required");
    }
    return await this.transaction(async () => {
      await this.queryClient().query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [lockName],
      );
      return await callback();
    });
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private queryClient(): PgliteQueryClient {
    return this.activeTransaction ?? this.client;
  }
}

/**
 * Create a real in-memory PGlite database for integration-style tests.
 */
export async function createLocalPgliteFixture<TDatabase>(
  schema: Record<string, unknown>,
): Promise<LocalPgliteFixture<TDatabase>> {
  const client = await PGlite.create(`memory://junior-sql-${randomUUID()}`);

  return new LocalPgliteExecutor<TDatabase>(client, schema);
}
