import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getSqlExecutor } from "@/chat/db";
import { measureSql } from "../fixtures/sql-budget";

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
});
