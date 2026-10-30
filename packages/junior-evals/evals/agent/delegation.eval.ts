import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { mockWebPages, mockWebSearchResults } from "@junior-evals/fixture/web";

// Short docs pages answer at once. The case measures the parent's choice to
// delegate, and the children's research is not checked, so live docs pages
// only make the run slow. Each page answers the whole question, so a child
// needs one read.
const POSTGRES_DOCS = {
  title: "PostgreSQL: ALTER TABLE",
  url: "https://www.postgresql.org/docs/current/sql-altertable.html",
  excerpt: "ADD COLUMN: locking, rewrite cost, and replication.",
};
const MYSQL_DOCS = {
  title: "MySQL 8.4: Online DDL Operations",
  url: "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html",
  excerpt: "ADD COLUMN: locking, rewrite cost, and replication.",
};
const SQLITE_DOCS = {
  title: "SQLite: ALTER TABLE",
  url: "https://www.sqlite.org/lang_altertable.html",
  excerpt: "ADD COLUMN: locking, rewrite cost, and replication.",
};

function docsPage(title: string, facts: string): string {
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${facts}</p></body></html>`;
}

const SQLITE_PAGE = docsPage(
  SQLITE_DOCS.title,
  "Rewrite cost: ADD COLUMN changes only the schema, at any table size. A NOT NULL column needs a constant default. Locking: a short database write lock. Replication: none built in.",
);

const DATABASE_DOCS_PAGES = {
  [POSTGRES_DOCS.url]: docsPage(
    POSTGRES_DOCS.title,
    "Rewrite cost: since version 11, ADD COLUMN with NOT NULL and a constant default changes only the catalog, at any table size. A volatile default rewrites the table. Locking: a short ACCESS EXCLUSIVE lock that waits behind long transactions. Replication: physical replicas replay the catalog change. Logical replication does not copy DDL.",
  ),
  [MYSQL_DOCS.url]: docsPage(
    MYSQL_DOCS.title,
    "Rewrite cost: ADD COLUMN, also with NOT NULL and a default, uses ALGORITHM=INSTANT by default and changes only metadata, at any table size. INSTANT does not apply to ROW_FORMAT=COMPRESSED tables or tables with a FULLTEXT index. Then MySQL rebuilds the table. Locking: a short metadata lock. Replication: replicas run the same statement, so a rebuild makes them lag.",
  ),
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
