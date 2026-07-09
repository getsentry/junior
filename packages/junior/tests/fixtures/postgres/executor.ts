import { type PoolClient, type QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { JuniorDatabase, JuniorSqlExecutor } from "@/db/db";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import { juniorSqlSchema } from "@/db/schema";

class ClientJuniorSqlExecutor implements JuniorSqlExecutor {
  private savepointId = 0;

  constructor(
    private readonly client: PoolClient,
    private readonly closeTransaction: () => Promise<void>,
  ) {}

  db(): JuniorDatabase {
    return drizzle(this.client, {
      schema: juniorSqlSchema,
    }) as JuniorDatabase;
  }

  async execute(
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<void> {
    await this.client.query(statement, [...params]);
  }

  async query<T = unknown>(
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.client.query<QueryResultRow>(statement, [
      ...params,
    ]);
    return result.rows as T[];
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const savepoint = `junior_test_savepoint_${++this.savepointId}`;
    await this.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await callback();
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  async withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T> {
    if (!lockName) {
      throw new Error("SQL lock name is required");
    }
    await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      lockName,
    ]);
    return await callback();
  }

  async close(): Promise<void> {
    await this.closeTransaction();
  }
}

/** Adapt a pinned Postgres client to Junior's SQL executor contract. */
export function createClientJuniorSqlExecutor(
  client: PoolClient,
  closeTransaction: () => Promise<void>,
): JuniorSqlExecutor {
  return new ClientJuniorSqlExecutor(client, closeTransaction);
}

/** Create a Junior SQL executor backed by an owned Postgres pool. */
export function createPooledJuniorSqlExecutor(args: {
  applicationName: string;
  connectionString: string;
}): {
  db: JuniorSqlExecutor;
  close(): Promise<void>;
} {
  const executor = createPostgresJuniorSqlExecutor({
    applicationName: args.applicationName,
    connectionString: args.connectionString,
  });
  return {
    db: executor,
    close: async () => {
      await executor.close();
    },
  };
}
