import { AsyncLocalStorage } from "node:async_hooks";
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

/** One SQL statement that a measured call sent, with its bind parameters. */
type SqlStatement = { text: string; params: readonly unknown[] };

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

// The store holds each measurement that the current work runs in, so a
// statement of other work, such as a background task that an earlier test
// left running, does not count. Measurements can nest.
const measuredCalls = new AsyncLocalStorage<ReadonlySet<object>>();

// `pg` takes `query(text, values)` or `query({ text, values }, values)`.
function statementOf(args: unknown): SqlStatement | undefined {
  const [first, second] = Array.from(args as ArrayLike<unknown>);
  const config = typeof first === "string" ? { text: first } : first;
  if (!config || typeof config !== "object" || !("text" in config)) return;
  const values = "values" in config ? config.values : undefined;
  const params = Array.isArray(second) ? second : values;
  return {
    text: String(config.text),
    params: Array.isArray(params) ? params : [],
  };
}

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
 * many of them wait on each other. Also returns the statements in start order.
 */
export async function measureSql<T>(
  call: () => T | Promise<T>,
): Promise<{ result: T; sql: SqlBudget; statements: SqlStatement[] }> {
  // Event order, not time, decides whether one statement waits on another.
  let order = 0;
  const owner = {};
  const owned = () => measuredCalls.getStore()?.has(owner) === true;
  const spans = new Map<PgCall, Span>();
  const statements: SqlStatement[] = [];
  const connectStarts = new WeakMap<PgCall, number>();
  // A `pool.query` statement runs its query in the checkout callback. It
  // starts when `pool.query` is called, not when a client is free, so the
  // measured order does not depend on the pool size.
  const checkouts: PgCall[] = [];
  const connect = {
    start: (context: PgCall) => {
      if (owned()) connectStarts.set(context, ++order);
    },
    end: ignore,
    // pg-pool can call a waiting checkout back from another caller's
    // release, so a checkout is known by its start, not by the store. A
    // checkout that the call did not start stays on the stack too, so its
    // statements do not count when this call's release runs it.
    asyncStart: (context: PgCall) => {
      checkouts.push(context);
    },
    asyncEnd: (context: PgCall) => {
      if (checkouts.at(-1) === context) checkouts.pop();
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
      if (checkout ? !connectStarts.has(checkout) : !owned()) return;
      const start = checkout && connectStarts.get(checkout);
      spans.set(context, { start: start ?? ++order });
      const statement = statementOf(context.arguments);
      if (statement) statements.push(statement);
    },
    end: ignore,
    asyncStart: ignore,
    asyncEnd: finish,
    error: finish,
  };
  POOL_CONNECT_CHANNEL.subscribe(connect);
  QUERY_CHANNEL.subscribe(query);
  try {
    // Await inside the store: a Drizzle query builder sends its SQL only
    // when it is awaited.
    const owners = new Set(measuredCalls.getStore()).add(owner);
    const result = await measuredCalls.run(owners, async () => await call());
    const all = [...spans.values()];
    return {
      result,
      sql: { statements: all.length, serialRounds: serialRounds(all) },
      statements,
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

/**
 * Assert that `call` sends no SQL that reads an Inbox table. Conversation
 * reads hold only Conversation data; the client overlays what waits on the
 * viewer from the Inbox's own route.
 */
export async function expectNoInboxSql<T>(
  call: () => T | Promise<T>,
): Promise<T> {
  const { result, statements } = await measureSql(call);
  expect(statements.length, "no SQL statement was measured").toBeGreaterThan(0);
  expect(
    statements
      .map(({ text }) => text)
      .filter((text) => /junior_inbox_item/.test(text)),
  ).toEqual([]);
  return result;
}
