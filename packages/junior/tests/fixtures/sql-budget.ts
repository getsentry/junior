import diagnosticsChannel from "node:diagnostics_channel";
import { expect } from "vitest";

/** The SQL work of one measured call. */
export type SqlBudget = {
  /** Statements that the call sent, `BEGIN` and `COMMIT` included. */
  statements: number;
  /**
   * The longest chain of statements where each one starts after the one
   * before it ends. Statements that run at the same time share a round.
   */
  serialRounds: number;
};

type Span = { start: number; end?: number };

// Channels that `pg-tracing-hook.ts` injects, the same ones that Sentry's
// Postgres integration reads to make database spans.
/**
 * The context of one traced `pg` call. The channel passes the same object to
 * every event of that call.
 */
type PgCall = { arguments?: unknown };

const QUERY_CHANNEL = diagnosticsChannel.tracingChannel<PgCall, PgCall>(
  "orchestrion:pg:query",
);
const POOL_CONNECT_CHANNEL = diagnosticsChannel.tracingChannel<PgCall, PgCall>(
  "orchestrion:pg-pool:connect",
);

const ignore = () => {};

function serialRounds(spans: readonly Span[]): number {
  const rounds: number[] = [];
  for (const [index, span] of spans.entries()) {
    let before = 0;
    for (const [previous, other] of spans.slice(0, index).entries()) {
      if (other.end !== undefined && other.end < span.start) {
        before = Math.max(before, rounds[previous]!);
      }
    }
    rounds.push(before + 1);
  }
  return Math.max(0, ...rounds);
}

/**
 * Run `call` and count the SQL statements that it sends through `pg`, and how
 * many of them wait on each other.
 */
export async function measureSql<T>(
  call: () => T | Promise<T>,
): Promise<{ result: T; sql: SqlBudget }> {
  // Event order, not time, decides whether one statement waits on another.
  let order = 0;
  const spans = new Map<PgCall, Span>();
  const connectStarts = new WeakMap<PgCall, number>();
  // A `pool.query` statement runs its query in the checkout callback. It
  // starts when `pool.query` is called, not when a client is free, so the
  // measured order does not depend on the pool size.
  const checkouts: PgCall[] = [];
  const connect = {
    start: (context: PgCall) => {
      connectStarts.set(context, ++order);
    },
    end: ignore,
    asyncStart: (context: PgCall) => {
      checkouts.push(context);
    },
    asyncEnd: () => {
      checkouts.pop();
    },
    error: ignore,
  };
  const finish = (context: PgCall) => {
    const span = spans.get(context);
    if (span) span.end = ++order;
  };
  const query = {
    start: (context: PgCall) => {
      const checkout = checkouts.at(-1);
      const start = checkout && connectStarts.get(checkout);
      spans.set(context, { start: start ?? ++order });
    },
    end: ignore,
    asyncStart: ignore,
    asyncEnd: finish,
    error: finish,
  };
  POOL_CONNECT_CHANNEL.subscribe(connect);
  QUERY_CHANNEL.subscribe(query);
  try {
    const result = await call();
    const all = [...spans.values()];
    return {
      result,
      sql: { statements: all.length, serialRounds: serialRounds(all) },
    };
  } finally {
    QUERY_CHANNEL.unsubscribe(query);
    POOL_CONNECT_CHANNEL.unsubscribe(connect);
  }
}

/**
 * Assert that `call` stays within a SQL budget. Set the budget to the
 * measured value. Lower it when a change sends fewer statements. Do not
 * raise it to pass.
 */
export async function expectSqlBudget<T>(
  call: () => T | Promise<T>,
  budget: SqlBudget,
): Promise<T> {
  const { result, sql } = await measureSql(call);
  expect(sql.statements, "no SQL statement was measured").toBeGreaterThan(0);
  expect(sql.statements).toBeLessThanOrEqual(budget.statements);
  expect(sql.serialRounds).toBeLessThanOrEqual(budget.serialRounds);
  return result;
}
