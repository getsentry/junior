import { AsyncLocalStorage } from "node:async_hooks";
import {
  Pool,
  type Client,
  type PoolClient,
  type QueryResultRow,
} from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { JuniorDatabase, JuniorSqlExecutor } from "./db";
import { juniorSqlSchema } from "./schema";

type QueryClient = Pool | PoolClient | Client;

/** Neon-backed SQL executor with an owned connection pool lifecycle. */
export type NeonJuniorSqlExecutor = JuniorSqlExecutor;

class NeonExecutor implements NeonJuniorSqlExecutor {
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();
  private savepointId = 0;

  constructor(private readonly pool: Pool) {}

  db(): JuniorDatabase {
    return drizzle(this.queryClient(), {
      schema: juniorSqlSchema,
    }) as JuniorDatabase;
  }

  async execute(
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<void> {
    await this.queryClient().query(statement, [...params]);
  }

  async query<T = unknown>(
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.queryClient().query<QueryResultRow>(statement, [
      ...params,
    ]);
    return result.rows as T[];
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const existingClient = this.transactionClient.getStore();
    if (existingClient) {
      const savepoint = `junior_savepoint_${++this.savepointId}`;
      await existingClient.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await callback();
        await existingClient.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await existingClient.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await existingClient.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.transactionClient.run(client, callback);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T> {
    if (!lockName) {
      throw new Error("SQL lock name is required");
    }
    const existingClient = this.transactionClient.getStore();
    if (existingClient) {
      await existingClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        lockName,
      ]);
      return await callback();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      return await this.transactionClient.run(client, async () => {
        try {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            lockName,
          ]);
          const result = await callback();
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private queryClient(): QueryClient {
    return this.transactionClient.getStore() ?? this.pool;
  }
}

/** Create the shared Neon-backed Junior SQL executor. */
export function createNeonJuniorSqlExecutor(args: {
  connectionString: string;
}): NeonJuniorSqlExecutor {
  return new NeonExecutor(
    new Pool({
      connectionString: args.connectionString,
      max: 3,
    }),
  );
}
