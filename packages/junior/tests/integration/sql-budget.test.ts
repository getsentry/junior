import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getSqlExecutor } from "@/chat/db";
import { juniorConversationMetrics } from "@/db/schema";
import { expectNoFullScan, measureSql } from "../fixtures/sql-budget";

describe("SQL budget measurement", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("counts statements that start together as one round", async () => {
    const executor = getSqlExecutor();
    // More reads than the pool has connections still share one round.
    const { sql: budget } = await measureSql(() =>
      Promise.all(
        Array.from({ length: 5 }, () => getDb().execute(sql`select 1`)),
      ),
    );
    expect(budget).toEqual({ statements: 5, serialRounds: 1 });

    const { sql: serial } = await measureSql(async () => {
      await executor.query("select 1");
      await getDb().execute(sql`select 2`);
    });
    expect(serial).toEqual({ statements: 2, serialRounds: 2 });
  });

  it("counts each statement of a transaction", async () => {
    const executor = getSqlExecutor();
    const { sql: budget } = await measureSql(() =>
      executor.transaction(() => executor.query("select 1")),
    );
    expect(budget).toEqual({ statements: 3, serialRounds: 3 });
  });

  it("finds a statement that reads a big table in full", async () => {
    const metrics = juniorConversationMetrics;
    const sum = () =>
      getDb()
        .select({ total: sql`sum(${metrics.value})` })
        .from(metrics);
    // No index holds `value` for every metric, so the sum reads the table.
    await expect(expectNoFullScan(sum)).rejects.toThrow(
      /statement 0 reads junior_conversation_metrics in full/,
    );
    // With seq scans off, a count reads a whole index instead.
    await expect(
      expectNoFullScan(() =>
        getDb()
          .select({ count: sql`count(*)` })
          .from(metrics),
      ),
    ).rejects.toThrow(/reads junior_conversation_metrics in full/);
    const allowSum = {
      "metric sum": {
        table: "junior_conversation_metrics",
        statement: "sum(",
        reason: "The sum reads every metric.",
      },
    };
    await expectNoFullScan(sum, allowSum);
    // An indexed read passes, and an allowance that it does not need fails.
    const indexed = () =>
      getDb()
        .select({ total: sql`sum(${metrics.value})` })
        .from(metrics)
        .where(eq(metrics.actorIdentityId, "identity-1"));
    await expectNoFullScan(indexed);
    await expect(expectNoFullScan(indexed, allowSum)).rejects.toThrow(
      /allowed full scan "metric sum" matches nothing/,
    );
  });
});
