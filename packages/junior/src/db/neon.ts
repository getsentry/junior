import { AsyncLocalStorage } from "node:async_hooks";
import {
  neon,
  Pool,
  type Client,
  type CustomTypesConfig,
  type PoolClient,
  type QueryResultRow,
} from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { MigrationConfig } from "drizzle-orm/migrator";
import { Agent } from "undici";
import type { JuniorDatabase, JuniorSqlExecutor } from "./db";
import { forwardInfoMessages } from "./info-messages";
import { applyMigrations, waitForMigrationLock } from "./migrate";
import { juniorSqlSchema } from "./schema";
import { logException } from "@/chat/logging";
import * as Sentry from "@/chat/sentry";

type QueryClient = Pool | PoolClient | Client;

type PlainQuery = {
  text: string;
  values?: unknown[];
  rowMode?: string;
  types?: CustomTypesConfig;
};

const POOL_MAX = 10;

/**
 * Sends a pool query over Neon's SQL-over-HTTP endpoint when no idle
 * WebSocket client is free.
 *
 * pg-pool reuses the newest idle client, so light polling keeps one or two
 * clients warm and the rest idle out. A parallel read batch then opens about
 * eight WebSockets, each with a new Postgres session. An HTTP query reuses the
 * proxy's cached backend connection, so the batch skips that handshake. The
 * warm path stays on WebSocket. `connect()` and transactions are unchanged.
 */
class OverflowPool extends Pool {
  // pg-pool takes an idle client one tick after `connect()`, so `idleCount`
  // still includes clients that queued queries already claimed.
  private pendingAcquires = 0;
  private readonly webSocketOnly = new AsyncLocalStorage<true>();
  private readonly sql;
  private readonly dispatcher: Agent;
  private readonly statementTimeoutMs: number | false | undefined;

  constructor(args: {
    connectionString: string;
    statementTimeoutMs?: number | false;
    dispatcher: Agent;
  }) {
    super({
      connectionString: args.connectionString,
      // One function instance serves many requests at once, and they share
      // this pool. A dashboard page load sends about ten requests, and the
      // conversation list alone can hold three connections for seconds. With
      // a smaller pool, the other requests wait for a free connection.
      max: POOL_MAX,
      // The pg default closes a client after 10s idle, which is also the
      // dashboard poll interval, so most polls and page loads opened new
      // WebSockets. Idle clients to the Neon pooler hold no Postgres backend.
      idleTimeoutMillis: 60_000,
      // Keeps the client that `reconnectWhenEmpty()` opens. Alone, `min` does
      // not keep a client open after a burst.
      min: 1,
      statement_timeout: args.statementTimeoutMs,
    });
    this.sql = neon(args.connectionString, { fullResults: true });
    this.dispatcher = args.dispatcher;
    this.statementTimeoutMs = args.statementTimeoutMs;
    this.on("remove", () => this.reconnectWhenEmpty());
  }

  // Loose parameters satisfy every pg `query` overload.
  override query(input: any, values?: any, callback?: any): any {
    const query: PlainQuery | undefined =
      typeof input === "string" ? { text: input } : input;
    if (
      callback !== undefined ||
      typeof values === "function" ||
      typeof query?.text !== "string" ||
      "submit" in query
    ) {
      return super.query(input, values, callback);
    }
    const params: unknown[] = values ?? query.values ?? [];
    // An empty pool opens its first client inline, as before, so the warm
    // path stays on WebSocket.
    if (
      this.webSocketOnly.getStore() ||
      this.idleCount > this.pendingAcquires ||
      this.totalCount === 0
    ) {
      return this.queryWebSocket(query, params);
    }
    this.growInBackground();
    return this.queryHttp(query, params);
  }

  // A new WebSocket client costs about as much as an HTTP query on its own,
  // and much more when a batch opens several at once. So the overflowed query
  // stays on HTTP, and a new client opens for the next batch. Idle clients
  // still close on the idle timeout.
  private growInBackground() {
    // Wait until pg-pool hands over the clients that queued queries claimed,
    // so `idleCount` is exact. With no idle client and room under `max`,
    // `connect()` opens a client at once and counts it in `totalCount`, so
    // checks that follow stay within `max`.
    setImmediate(() => {
      if (this.ending || this.idleCount > 0 || this.totalCount >= POOL_MAX) {
        return;
      }
      this.openClient();
    });
  }

  // pg-pool `min` keeps a client only when it is released into a pool that
  // already holds `min` clients or fewer. Its idle timer does not check
  // `min` again, so clients released while the pool was larger all close.
  // Open one client when the last one closes. It is released into a pool of
  // one, so it stays open. A failed connect does not emit `remove`, so it
  // makes only one attempt.
  private reconnectWhenEmpty() {
    // After pg-pool serves queued queries, which can open a client.
    setImmediate(() => {
      if (this.ending || this.totalCount > 0) {
        return;
      }
      this.openClient();
    });
  }

  private openClient() {
    this.connect((error, client) => {
      if (client) {
        client.release();
        return;
      }
      logException(error, "db.pool.client.connect_failed", {
        "app.db.driver": "neon",
      });
    });
  }

  /** Keep every pool query in `callback` on WebSocket. */
  async onWebSocket<T>(callback: () => Promise<T>): Promise<T> {
    return await this.webSocketOnly.run(true, callback);
  }

  private async queryWebSocket(query: PlainQuery, params: unknown[]) {
    const client = await this.acquire();
    try {
      const result = await client.query({ ...query, values: params });
      client.release();
      return result;
    } catch (error) {
      // Like pg-pool `query`: drop the client after any query error.
      client.release(error as Error);
      throw error;
    }
  }

  // pg-pool calls this callback in the same step that removes the client from
  // `idleCount`. A promise would resume later, and queries in between would
  // count that client twice.
  private acquire(): Promise<PoolClient> {
    this.pendingAcquires++;
    return new Promise((resolve, reject) => {
      this.connect((error, client) => {
        this.pendingAcquires--;
        if (client) {
          resolve(client);
        } else {
          reject(error);
        }
      });
    });
  }

  private async queryHttp(query: PlainQuery, params: unknown[]) {
    const fetchOptions: { dispatcher: Agent; signal?: AbortSignal } = {
      dispatcher: this.dispatcher,
    };
    // The HTTP endpoint has no per-request statement_timeout. This abort ends
    // the wait. Neon does not say that it cancels the query.
    if (this.statementTimeoutMs) {
      fetchOptions.signal = AbortSignal.timeout(this.statementTimeoutMs);
    }
    // Nothing retries this request: it can carry an autocommit write.
    return await Sentry.withScope(async (scope) => {
      scope.setAttributes({ "app.db.transport": "http" });
      return await this.sql.query(query.text, params, {
        arrayMode: query.rowMode === "array",
        fullResults: true,
        types: query.types ?? this.options.types,
        fetchOptions,
      });
    });
  }
}

/** Neon-backed SQL executor with an owned connection pool lifecycle. */
export type NeonJuniorSqlExecutor = JuniorSqlExecutor;

class NeonExecutor implements NeonJuniorSqlExecutor {
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();
  private savepointId = 0;
  private isolatedQueryId = 0;

  private readonly pool: OverflowPool;
  private readonly dispatcher: Agent;

  constructor(pool: OverflowPool, dispatcher: Agent) {
    this.pool = pool;
    this.dispatcher = dispatcher;
  }

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
    const client = await this.pool.connect();
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
    await applyMigrations(this, config);
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
      await waitForMigrationLock(async () => {
        const result = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          [lockName],
        );
        return result.rows[0]?.locked === true;
      });
      // DDL such as `CREATE INDEX CONCURRENTLY` can outlast an HTTP request,
      // and only a WebSocket session's statement_timeout cancels it.
      return await this.pool.onWebSocket(callback);
    } finally {
      // Ending the session releases the lock without replacing a migration error.
      client.release(true);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    await this.dispatcher.close();
  }

  private queryClient(): QueryClient {
    return this.transactionClient.getStore() ?? this.pool;
  }
}

/** Create the shared Neon-backed Junior SQL executor. */
export function createNeonJuniorSqlExecutor(args: {
  connectionString: string;
  onInfo?: (message: string) => void;
  statementTimeoutMs?: number | false;
}): NeonJuniorSqlExecutor {
  const { onInfo, ...poolArgs } = args;
  // On HTTP/2, a warm socket carries many overflow queries at once.
  const dispatcher = new Agent({ allowH2: true });
  const pool = new OverflowPool({ ...poolArgs, dispatcher });
  // An idle client can fail when the server closes it. The pool replaces the
  // client, so report the error instead of crashing the process.
  pool.on("error", (error: Error) => {
    logException(error, "db.pool.client.failed", { "app.db.driver": "neon" });
  });
  // Messages from SQL-over-HTTP queries do not arrive. Migrations run in a
  // transaction on a WebSocket client, so their messages do.
  if (onInfo) {
    forwardInfoMessages(pool, onInfo);
  }
  return new NeonExecutor(pool, dispatcher);
}
