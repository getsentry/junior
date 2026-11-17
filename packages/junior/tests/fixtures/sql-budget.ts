import diagnosticsChannel from "node:diagnostics_channel";
import { expect } from "vitest";
import {
  SQL_STATEMENT_CHANNEL,
  type SqlStatementMessage,
} from "@/db/statement-channel";

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

function isSqlStatementMessage(value: unknown): value is SqlStatementMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "phase" in value &&
    "statement" in value
  );
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
 * Run `call` and count the SQL statements that it sends through the process
 * executor, and how many of them wait on each other.
 */
export async function measureSql<T>(
  call: () => T | Promise<T>,
): Promise<{ result: T; sql: SqlBudget }> {
  // Message order, not time, decides whether one statement waits on another.
  let order = 0;
  const spans = new Map<object, Span>();
  const listener = (message: unknown) => {
    if (!isSqlStatementMessage(message)) return;
    order += 1;
    if (message.phase === "start") {
      spans.set(message.statement, { start: order });
    } else {
      const span = spans.get(message.statement);
      if (span) span.end = order;
    }
  };
  diagnosticsChannel.subscribe(SQL_STATEMENT_CHANNEL, listener);
  try {
    const result = await call();
    const all = [...spans.values()];
    return {
      result,
      sql: { statements: all.length, serialRounds: serialRounds(all) },
    };
  } finally {
    diagnosticsChannel.unsubscribe(SQL_STATEMENT_CHANNEL, listener);
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
