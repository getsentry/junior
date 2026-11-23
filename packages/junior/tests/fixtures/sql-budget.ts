import diagnosticsChannel from "node:diagnostics_channel";
import { expect } from "vitest";
import { getSqlExecutor } from "@/chat/db";

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
  const spans = new Map<PgCall, Span>();
  const statements: SqlStatement[] = [];
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
    const result = await call();
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

/** A plan node of `EXPLAIN (FORMAT JSON)`, with the fields this file reads. */
type PlanNode = {
  "Node Type": string;
  "Total Cost": number;
  "Relation Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: PlanNode[];
};

function* planNodes(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* planNodes(child);
}

/**
 * Whether a plan node reads every row of its table: a `Seq Scan`, or an index
 * or bitmap scan with no condition. With seq scans off, Postgres reads a whole
 * index instead of the table when it can.
 */
function isFullScan(node: PlanNode): boolean {
  switch (node["Node Type"]) {
    case "Seq Scan":
      return true;
    case "Index Scan":
    case "Index Only Scan":
      return node["Index Cond"] === undefined;
    case "Bitmap Heap Scan":
      return node["Recheck Cond"] === undefined;
    default:
      return false;
  }
}

// Only these statements have a plan. `BEGIN`, `SET`, and the like do not.
const EXPLAINABLE = /^\s*(?:select|with|insert|update|delete)\b/i;

/**
 * Explain each statement that has a plan, with `EXPLAIN (FORMAT JSON)` and
 * the bind parameters that it sent. That is the plan that Postgres made for
 * the request, because `pg` plans each unnamed statement with its values.
 * `EXPLAIN` does not run the statement, so writes are safe to explain. The
 * explains run in one transaction on `getSqlExecutor()`, the
 * product-configured database, after `setup` when it is given.
 */
async function explainPlans(
  statements: readonly SqlStatement[],
  setup?: string,
): Promise<{ text: string; plan: PlanNode }[]> {
  const explainable = statements.filter((statement) =>
    EXPLAINABLE.test(statement.text),
  );
  expect(explainable.length, "no SQL statement was explained").toBeGreaterThan(
    0,
  );
  const executor = getSqlExecutor();
  return executor.transaction(async () => {
    if (setup) await executor.execute(setup);
    const plans: { text: string; plan: PlanNode }[] = [];
    for (const statement of explainable) {
      const [row] = await executor.query<{
        "QUERY PLAN": [{ Plan: PlanNode }];
      }>(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.params);
      plans.push({ text: statement.text, plan: row!["QUERY PLAN"][0].Plan });
    }
    return plans;
  });
}

// Tables that grow with use, so a full read of one gets slower over time.
const BIG_TABLES = [
  "junior_code_changes",
  "junior_conversation_briefs",
  "junior_conversation_metrics",
  "junior_memory_memories",
];

/**
 * A known full scan that a fix will remove. It matches a full scan of `table`
 * in a statement whose text contains `statement`.
 */
type FullScanAllowance = {
  table: string;
  statement: string;
  reason: string;
};

/**
 * Assert that the statements of `call` read no big table in full. A big table
 * grows with use, such as `junior_conversation_metrics`.
 *
 * Each statement is explained after `call` ends. Postgres reads a small test
 * table in full even when an index fits. So the statements are explained with
 * `SET LOCAL enable_seqscan = off`, and a full scan is left only when no index
 * condition can serve the statement. A join that probes an index for each
 * outer row passes, however many rows it reads.
 *
 * `allowed` names known full scans, keyed by name. The assertion also fails
 * when an entry matches no full scan, so the fix must remove it.
 */
export async function expectNoFullScan<T>(
  call: () => T | Promise<T>,
  allowed: Readonly<Record<string, FullScanAllowance>> = {},
): Promise<T> {
  const { result, statements } = await measureSql(call);
  const plans = await explainPlans(
    statements,
    "SET LOCAL enable_seqscan = off",
  );
  const allowances = Object.entries(allowed);
  const used = new Set<string>();
  const failures: string[] = [];
  for (const [index, { text, plan }] of plans.entries()) {
    for (const node of planNodes(plan)) {
      const table = node["Relation Name"];
      if (!table || !BIG_TABLES.includes(table) || !isFullScan(node)) continue;
      const allowance = allowances.find(
        ([, entry]) => entry.table === table && text.includes(entry.statement),
      );
      if (allowance) {
        used.add(allowance[0]);
        continue;
      }
      failures.push(
        `statement ${index} reads ${table} in full (${node["Node Type"]}): ${text}`,
      );
    }
  }
  for (const [name] of allowances) {
    if (!used.has(name)) {
      failures.push(`allowed full scan "${name}" matches nothing; remove it`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return result;
}

/**
 * Assert that no statement of `call` has an estimated total cost over
 * `maxCost`. A statement shape that makes Postgres do work for each row of a
 * list, such as one correlated subquery for each ID, raises its cost before
 * the test data is big enough to make it slow. A high cost also turns on JIT
 * compilation (`jit_above_cost`), which can take longer than the statement.
 *
 * Each statement is explained after `call` ends, with the default planner
 * settings. The cost depends on the seeded rows, so set `maxCost` with
 * headroom over the measured cost. Do not raise it to pass.
 */
export async function expectPlanCost<T>(
  call: () => T | Promise<T>,
  maxCost: number,
): Promise<T> {
  const { result, statements } = await measureSql(call);
  const plans = await explainPlans(statements);
  const failures: string[] = [];
  for (const [index, { text, plan }] of plans.entries()) {
    if (plan["Total Cost"] > maxCost) {
      failures.push(
        `statement ${index} costs ${plan["Total Cost"]}, over ${maxCost}: ${text}`,
      );
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return result;
}
