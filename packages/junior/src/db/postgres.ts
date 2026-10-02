import { AsyncLocalStorage } from "node:async_hooks";
import pg, {
  type Pool as PgPool,
  type PoolClient,
  type QueryResultRow,
} from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { MigrationConfig } from "drizzle-orm/migrator";
import type { JuniorDatabase, JuniorSqlExecutor } from "./db";
import { juniorSqlSchema } from "./schema";
import { traceQueries } from "./tracing";
import { logException } from "@/chat/logging";

const { Pool } = pg;

type QueryClient = PgPool | PoolClient;

class PostgresExecutor implements JuniorSqlExecutor {
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();
  private savepointId = 0;
  private isolatedQueryId = 0;

  constructor(
    private readonly pool: PgPool,
    private readonly connectionString: string,
  ) {}

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

  async queryIsolated<T = unknown>(
    statement: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const client = traceQueries(await this.pool.connect(), {
      connectionString: this.connectionString,
      driver: "postgres",
    });
    try {
      // A named statement uses the extended protocol, which accepts one statement only.
      const result = await client.query<QueryResultRow>({
        name: `junior_isolated_${++this.isolatedQueryId}`,
        text: statement,
        values: [...params],
      });
      return result.rows as T[];
    } finally {
      client.release(true);
    }
  }

  async migrate(config: MigrationConfig): Promise<void> {
    await migrate(
      drizzle(this.queryClient(), { schema: juniorSqlSchema }),
      config,
    );
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

  async withMigrationLock<T>(
    migrationTable: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const lockName = `junior:migrate:${migrationTable}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);
      return await callback();
    } finally {
      // Ending the session releases the lock without replacing a migration error.
      client.release(true);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private queryClient(): QueryClient {
    return traceQueries(this.transactionClient.getStore() ?? this.pool, {
      connectionString: this.connectionString,
      driver: "postgres",
    });
  }
}

/** Create the shared Node Postgres-backed Junior SQL executor. */
export function createPostgresJuniorSqlExecutor(args: {
  applicationName?: string;
  connectionString: string;
  statementTimeoutMs?: number | false;
}): JuniorSqlExecutor {
  const pool = new Pool({
    application_name: args.applicationName,
    connectionString: args.connectionString,
    max: 3,
    statement_timeout: args.statementTimeoutMs,
  });
  // An idle client can fail when the server closes it. The pool replaces the
  // client, so report the error instead of crashing the process.
  pool.on("error", (error) => {
    logException(error, "db.pool.client.failed", {
      "app.db.driver": "postgres",
    });
  });
  return new PostgresExecutor(pool, args.connectionString);
}
