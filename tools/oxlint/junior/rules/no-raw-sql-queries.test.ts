import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRawSqlQueriesRule } from "./no-raw-sql-queries.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const noRawSqlQueries = [{ messageId: "noRawSqlQueries" }];

new RuleTester().run("no-raw-sql-queries", noRawSqlQueriesRule, {
  valid: [
    "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);",
    "await db.select({ id: table.id }).from(table).where(sql`${table.id} = any(${ids})`);",
    "await executor.execute(`INSERT INTO drizzle.migrations (hash) VALUES ($1)`, [hash]);",
  ],
  invalid: [
    {
      code: "await db.execute(sql`SELECT count(*) FROM ${table}`);",
      errors: noRawSqlQueries,
    },
    {
      code: "await db.execute(sql`\n  WITH recent AS (SELECT id FROM junior_code_changes)\n  SELECT * FROM recent\n`);",
      errors: noRawSqlQueries,
    },
    {
      code: "await getSqlExecutor().db().execute(sql`insert into ${e} select ${e.seq} from ${e}`);",
      errors: noRawSqlQueries,
    },
  ],
});
