import diagnosticsChannel from "node:diagnostics_channel";
import type { Pool, PoolClient } from "pg";

/**
 * Diagnostics channel for SQL statements. Each statement publishes a `start`
 * and then an `end` message with the same `statement` object. Tests subscribe
 * to count the statements of one request and how many wait on each other.
 */
export const SQL_STATEMENT_CHANNEL = "junior:sql:statement";

/** A message on `SQL_STATEMENT_CHANNEL`. */
export type SqlStatementMessage = {
  phase: "start" | "end";
  /** The same object for the start and the end of one statement. */
  statement: object;
};

const channel = diagnosticsChannel.channel(SQL_STATEMENT_CHANNEL);

function publish(message: SqlStatementMessage): void {
  channel.publish(message);
}

// pg overloads `query` and `connect`, so a typed `apply` cannot forward
// arguments that it does not inspect.
function forward(
  fn: (...args: never[]) => unknown,
  self: Pool | PoolClient,
  args: unknown[],
): unknown {
  return Function.prototype.apply.call(fn, self, args);
}

function isSubmittable(value: unknown): boolean {
  return typeof value === "object" && value !== null && "submit" in value;
}

function traceQueries(target: Pool | PoolClient, traced: () => boolean): void {
  const query = target.query;
  Object.defineProperty(target, "query", {
    configurable: true,
    value: (...args: unknown[]): unknown => {
      // A stream query has no single end, so it is not traced.
      if (!channel.hasSubscribers || !traced() || isSubmittable(args[0])) {
        return forward(query, target, args);
      }
      const statement = {};
      const end = () => publish({ phase: "end", statement });
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = (...results: unknown[]) => {
          end();
          callback.apply(undefined, results);
        };
      }
      publish({ phase: "start", statement });
      const result = forward(query, target, args);
      return result instanceof Promise ? result.finally(end) : result;
    },
  });
}

/**
 * Publish the start and end of each statement that `pool` runs. A
 * `pool.query` statement starts when it is called, not when it gets a
 * connection, so the measured order does not depend on the pool size. A
 * statement on a client from `pool.connect()`, such as in a transaction, is
 * traced while that client is checked out. With no subscriber, a statement
 * runs as before.
 */
export function traceSqlPool(pool: Pool): void {
  const checkedOut = new WeakSet<PoolClient>();
  traceQueries(pool, () => true);
  pool.on("connect", (client) => {
    traceQueries(client, () => checkedOut.has(client));
  });
  const connect = pool.connect;
  Object.defineProperty(pool, "connect", {
    configurable: true,
    value: (...args: unknown[]): unknown => {
      const result = forward(connect, pool, args);
      // `pool.query` checks out with a callback. Its statement is traced
      // above, so only a promise checkout traces its client.
      if (!(result instanceof Promise)) return result;
      return result.then((client: PoolClient) => {
        checkedOut.add(client);
        const release = client.release;
        client.release = (...releaseArgs: unknown[]) => {
          checkedOut.delete(client);
          forward(release, client, releaseArgs);
        };
        return client;
      });
    },
  });
}
