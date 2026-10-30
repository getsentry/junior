import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { mockWebPages, mockWebSearchResults } from "@junior-evals/fixture/web";

// Fixed docs pages answer at once. The case measures the parent's choice to
// delegate, and the children's research is not checked, so live docs pages
// only make the run slow. Each page covers the whole question in a few
// paragraphs. Shorter pages look cut off, and then children read more pages
// until they reach their tool-call limit.
const POSTGRES_DOCS = {
  title: "PostgreSQL: ALTER TABLE",
  url: "https://www.postgresql.org/docs/current/sql-altertable.html",
  excerpt:
    "ADD COLUMN with a non-volatile DEFAULT changes only the catalog. The table is not rewritten.",
};
const MYSQL_DOCS = {
  title: "MySQL 8.4: Online DDL Operations",
  url: "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html",
  excerpt:
    "ALGORITHM=INSTANT is the default for ADD COLUMN. Only metadata changes.",
};
const SQLITE_DOCS = {
  title: "SQLite: ALTER TABLE",
  url: "https://www.sqlite.org/lang_altertable.html",
  excerpt:
    "ADD COLUMN changes only the schema text. Its time does not depend on the amount of data.",
};

function docsPage(title: string, paragraphs: string[]): string {
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1>${paragraphs
    .map((text) => `<p>${text}</p>`)
    .join("")}</body></html>`;
}

const SQLITE_PAGE = docsPage(SQLITE_DOCS.title, [
  "ALTER TABLE ADD COLUMN changes only the schema text in sqlite_schema. Its time does not depend on the amount of data in the table.",
  "A NOT NULL column needs a default that is not NULL. The default cannot be CURRENT_TIME, CURRENT_DATE, CURRENT_TIMESTAMP, or an expression in parentheses.",
  "The statement takes the database write lock for a short time. SQLite has no built-in replication. Tools that copy WAL pages, such as Litestream, copy the small schema change.",
]);

const DATABASE_DOCS_PAGES = {
  [POSTGRES_DOCS.url]: docsPage(POSTGRES_DOCS.title, [
    "Since PostgreSQL 11, ADD COLUMN with a NOT NULL constraint and a non-volatile DEFAULT stores the default in the catalog and does not rewrite the table, so it is fast on a very large table. A volatile default, such as clock_timestamp(), rewrites the whole table.",
    "ALTER TABLE takes an ACCESS EXCLUSIVE lock for the short catalog change. The lock waits behind long transactions, and queries queue behind it. Set lock_timeout to limit the wait.",
    "Streaming replication sends the small catalog change in the WAL. Logical replication does not replicate DDL: add the column on each subscriber first.",
  ]),
  [MYSQL_DOCS.url]: docsPage(MYSQL_DOCS.title, [
    "In MySQL 8.0.29 and later, ADD COLUMN uses ALGORITHM=INSTANT by default, also for a NOT NULL column with a DEFAULT. It changes only metadata, so it is fast on a very large table, and concurrent DML continues.",
    "INSTANT does not apply to ROW_FORMAT=COMPRESSED tables, tables with a FULLTEXT index, or temporary tables, and a table allows at most 64 instant row versions. Then MySQL rebuilds the table with ALGORITHM=INPLACE. The statement takes a short exclusive metadata lock at its start and end.",
    "The ALTER TABLE statement goes to replicas in the binary log. An instant change is also fast on a replica. A rebuild runs again on each replica and blocks the replication applier, so replicas lag.",
  ]),
  [SQLITE_DOCS.url]: SQLITE_PAGE,
  // The SQLite docs are also served without "www".
  "https://sqlite.org/lang_altertable.html": SQLITE_PAGE,
};

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself.
describe("Implicit Delegation", () => {
  test("when a request splits into independent research tracks, start a child agent for each track", async ({
    agent,
  }) => {
    // A small budget keeps each child short. The case measures the parent's
    // choice to delegate, not the quality of the children's research.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockWebSearchResults([POSTGRES_DOCS, MYSQL_DOCS, SQLITE_DOCS]);
    mockWebPages(DATABASE_DOCS_PAGES);
    const conversation = await run(
      slackMention(
        "I need to pick a database for a new service. Research how PostgreSQL, MySQL, and SQLite each handle adding a NOT NULL column with a default to a very large table: locking, rewrite cost, and replication impact. Go to each project's own docs, then give me the tradeoffs.",
      ),
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
  });

  test("when a request needs only a few direct tool calls, do the work without a child agent", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC and in Tokyo?"),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
  });
});
