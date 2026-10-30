import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import {
  mockWebPages,
  mockWebSearchResults,
  type WebSearchResult,
} from "@junior-evals/fixture/web";

interface DocsPage {
  title: string;
  /** The first URL is the one that search results show. */
  urls: [string, ...string[]];
  paragraphs: [string, ...string[]];
}

const MYSQL_ONLINE_DDL_COLUMN_OPERATIONS: DocsPage["paragraphs"] = [
  "Adding a column: ALTER TABLE tbl_name ADD COLUMN column_name column_definition, ALGORITHM=INSTANT. INSTANT is the default algorithm. It was added in MySQL 8.0.12, and since 8.0.29 it can add a column at any position. A NOT NULL column with a constant DEFAULT can be added with INSTANT. INSTANT only modifies metadata in the data dictionary. It does not rebuild the table and permits concurrent DML, so its time does not depend on the size of the table.",
  "Limitations of INSTANT: a statement cannot combine the addition of a column with other ALTER TABLE actions that do not support INSTANT. Columns cannot be added to tables that use ROW_FORMAT=COMPRESSED, tables with a FULLTEXT index, tables in the data dictionary tablespace, or temporary tables. Each instant add or drop makes a new row version, and a table permits at most 64 row versions. After that limit, or if the row size or column count limit is exceeded, the statement fails with an error that tells you to use INPLACE or COPY.",
  "ALGORITHM=INPLACE to add a column rebuilds the table, but permits concurrent DML. ALGORITHM=COPY copies the table to a new table and does not permit concurrent DML. A rebuild needs time and free disk space in proportion to the size of the table and its indexes. Adding an auto-increment column does not permit concurrent DML and needs at least ALGORITHM=INPLACE, LOCK=SHARED.",
  "Locking: an online DDL operation takes an exclusive metadata lock for a short time during preparation and again at commit. It must wait for transactions that hold metadata locks on the table to commit or roll back. A long running or idle transaction can make it time out (lock_wait_timeout). While the exclusive metadata lock is pending, it blocks later transactions on the table, also plain SELECT statements. LOCK=NONE, SHARED, or EXCLUSIVE sets concurrency for INPLACE and COPY. Only LOCK=DEFAULT is permitted with ALGORITHM=INSTANT.",
  "Replication: the ALTER TABLE statement is written to the binary log and runs on each replica after it finishes on the source. An INSTANT change is also fast on the replica. A long INPLACE or COPY operation runs again on the replica, and DML that ran on the source at the same time is applied only after the DDL finishes on the replica, so the replica lags.",
];

// Fixed docs pages answer at once. The case measures the parent's choice to
// delegate, and the children's research is not checked, so live docs pages
// only make the run slow. The pages are the ones that the parent's tasks name
// and that the children read or search for in replays of earlier runs. The
// main page of each database answers its whole task: rules, rewrite cost,
// locking, and replication. Other paths on these sites get 404.
const DATABASE_DOCS: DocsPage[] = [
  {
    title: "PostgreSQL: ALTER TABLE",
    urls: ["https://www.postgresql.org/docs/current/sql-altertable.html"],
    paragraphs: [
      "When a column is added with ADD COLUMN and a non-volatile DEFAULT is specified, the default value is evaluated at the time of the statement and the result stored in the table's metadata. A rewrite of the table is not required, so the statement is fast also on a very large table. This is so since PostgreSQL 11. Because every existing row gets the default, a NOT NULL constraint on the new column does not need a scan.",
      "Adding a column with a volatile DEFAULT (e.g., clock_timestamp() or random()), a stored generated column, an identity column, or a column with a domain data type that has constraints will cause the entire table and its indexes to be rewritten. Adding a CHECK or NOT NULL constraint to an existing column requires a scan of the table, but not a rewrite.",
      "ADD COLUMN acquires an ACCESS EXCLUSIVE lock, which conflicts with all other locks, also with the ACCESS SHARE lock of SELECT. For a change to the metadata only, the lock is held for a short time. But the statement must wait for all transactions that use the table, and later queries on the table wait behind it. Set lock_timeout so that the statement fails instead of blocking the queue for a long time.",
      "Replication: on streaming replicas, a change to the metadata only writes little WAL, and the replica applies it at once. A table rewrite writes WAL for the whole table and its indexes. Logical replication does not replicate DDL. Add the column on each subscriber first, then on the publisher.",
    ],
  },
  {
    title: "PostgreSQL 11 Release Notes",
    urls: [
      "https://www.postgresql.org/docs/11/release-11.html",
      "https://www.postgresql.org/docs/release/11.0/",
    ],
    paragraphs: [
      "Allow ALTER TABLE to add a column with a non-null default without doing a table rewrite (Andrew Dunstan, Serge Rielau). This is enabled when the default value is a constant.",
    ],
  },
  {
    title: "PostgreSQL: Explicit Locking",
    urls: ["https://www.postgresql.org/docs/current/explicit-locking.html"],
    paragraphs: [
      "ACCESS EXCLUSIVE conflicts with locks of all modes. This mode guarantees that the holder is the only transaction accessing the table in any way. It is acquired by most forms of ALTER TABLE. A lock request waits for conflicting locks that other transactions hold, and later lock requests on the table wait behind it.",
    ],
  },
  {
    title: "PostgreSQL: Logical Replication Restrictions",
    urls: [
      "https://www.postgresql.org/docs/current/logical-replication-restrictions.html",
    ],
    paragraphs: [
      "The database schema and DDL commands are not replicated. Schema changes need to be kept in sync manually. When the schema is changed on the publisher and replicated data does not fit into the table schema on the subscriber, replication will error until the schema is updated. Apply additive schema changes to the subscriber first.",
    ],
  },
  {
    title: "MySQL 8.4 Reference Manual: Online DDL Operations",
    urls: [
      "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html",
    ],
    paragraphs: MYSQL_ONLINE_DDL_COLUMN_OPERATIONS,
  },
  {
    title: "MySQL 8.0 Reference Manual: Online DDL Operations",
    urls: [
      "https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl-operations.html",
    ],
    paragraphs: MYSQL_ONLINE_DDL_COLUMN_OPERATIONS,
  },
  {
    title: "MySQL 8.4 Reference Manual: InnoDB and Online DDL",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl.html"],
    paragraphs: [
      "Online DDL lets InnoDB change a table with the INSTANT or INPLACE algorithm while the table stays available for reads and writes. Online DDL Operations lists the algorithm, rebuild, and concurrency of each operation, also for adding a column. Online DDL Performance and Concurrency tells about metadata locks. Online DDL Limitations tells about replication.",
    ],
  },
  {
    title: "MySQL 8.4 Reference Manual: ALTER TABLE Statement",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/alter-table.html"],
    paragraphs: [
      "ALGORITHM={DEFAULT|INSTANT|INPLACE|COPY}. If the ALGORITHM clause is omitted, MySQL uses ALGORITHM=INSTANT for storage engines and ALTER TABLE clauses that support it, else INPLACE, else COPY. If the requested algorithm is not supported, the statement fails with an error.",
      "LOCK={DEFAULT|NONE|SHARED|EXCLUSIVE} controls concurrent reads and writes for INPLACE and COPY. LOCK=DEFAULT permits the maximum concurrency of the algorithm. Only LOCK=DEFAULT is permitted for operations that use ALGORITHM=INSTANT.",
    ],
  },
  {
    title: "MySQL 8.4 Reference Manual: Online DDL Performance and Concurrency",
    urls: [
      "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-performance.html",
    ],
    paragraphs: [
      "An online DDL operation takes an exclusive metadata lock on the table for a short time during preparation and at commit. It may have to wait for concurrent transactions that hold metadata locks on the table to commit or roll back. In the case of a long running or inactive transaction, it can time out. A pending exclusive metadata lock blocks subsequent transactions on the table, also SELECT statements.",
    ],
  },
  {
    title: "MySQL 8.4 Reference Manual: Metadata Locking",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html"],
    paragraphs: [
      "A transaction holds metadata locks on the tables that it uses until it ends. ALTER TABLE must get an exclusive metadata lock, so it waits for open transactions on the table. Lock requests wait in a queue, and later requests on the table wait behind the pending ALTER TABLE. lock_wait_timeout sets how long a statement waits for a metadata lock.",
    ],
  },
  {
    title: "MySQL 8.4 Reference Manual: Online DDL Limitations",
    urls: [
      "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-limitations.html",
    ],
    paragraphs: [
      "Long running online DDL operations can cause replication lag. An online DDL operation must finish running on the source before it is run on the replica. Also, DML that was processed concurrently on the source is only processed on the replica after the DDL operation on the replica is completed. An operation that rebuilds the table needs temporary disk space for the copy of the table and for sort files.",
    ],
  },
  {
    title: "SQLite: ALTER TABLE",
    urls: [
      "https://www.sqlite.org/lang_altertable.html",
      "https://sqlite.org/lang_altertable.html",
    ],
    paragraphs: [
      "ADD COLUMN: the new column cannot have a PRIMARY KEY or UNIQUE constraint. If a NOT NULL constraint is specified, then the column must have a default value other than NULL. The default cannot be CURRENT_TIME, CURRENT_DATE, CURRENT_TIMESTAMP, or an expression in parentheses. A generated column cannot be STORED.",
      "ADD COLUMN only modifies the text of the schema in sqlite_schema and does not read or write the rows of the table. Because of this, its execution time is independent of the amount of data in the table, and it runs as quickly on a table with 10 million rows as on a table with 1 row. Only a CHECK constraint, or a NOT NULL constraint on a generated column, makes SQLite read all existing rows to test the constraint.",
      "Locking: like every write, ALTER TABLE takes the write lock of the whole database. One connection at a time can write. In rollback-journal mode, readers are blocked only for the short commit. In WAL mode, readers are not blocked. Because ADD COLUMN changes only the schema, the lock is held for a very short time.",
      "Replication: SQLite has no built-in replication. The online backup API and the sqlite3_rsync utility copy a database to another place, and a copy after ADD COLUMN has the new schema.",
      "For a schema change that ADD COLUMN cannot do, use the generalized 12-step procedure: in one transaction, create a new table, copy the data, drop the old table, and rename the new table. This rewrites all the data.",
    ],
  },
  {
    title: "SQLite: File Locking And Concurrency In SQLite Version 3",
    urls: ["https://www.sqlite.org/lockingv3.html"],
    paragraphs: [
      "A database file is in one of these lock states: UNLOCKED, SHARED, RESERVED, PENDING, or EXCLUSIVE. Many connections can hold SHARED locks and read at the same time. Only one connection can hold a RESERVED lock and plan a write. To commit in rollback-journal mode, the writer gets an EXCLUSIVE lock, and readers wait until the commit ends.",
    ],
  },
  {
    title: "SQLite: Write-Ahead Logging",
    urls: ["https://www.sqlite.org/wal.html"],
    paragraphs: [
      "WAL provides more concurrency as readers do not block writers and a writer does not block readers. Reading and writing can proceed concurrently. However, since there is only one WAL file, there can only be one writer at a time.",
    ],
  },
  {
    title: "SQLite: Using the SQLite Online Backup API",
    urls: ["https://www.sqlite.org/backup.html"],
    paragraphs: [
      "The online backup API copies the content of one database into another database, also while the source database is in use. The copy includes the schema.",
    ],
  },
  {
    title: "SQLite: sqlite3_rsync",
    urls: ["https://www.sqlite.org/rsync.html"],
    paragraphs: [
      "The sqlite3_rsync ORIGIN REPLICA command causes REPLICA to become a copy of ORIGIN. It sends only the pages that changed, so a copy after a small schema change sends little data.",
    ],
  },
  {
    title: "SQLite: The Session Extension",
    urls: ["https://www.sqlite.org/sessionintro.html"],
    paragraphs: [
      "The session extension records changes to the rows of tables in a changeset, which can be applied to another database. It records INSERT, UPDATE, and DELETE on rows, not schema changes such as ALTER TABLE.",
    ],
  },
];

function docsPage(doc: DocsPage): string {
  return `<html><head><title>${doc.title}</title></head><body><h1>${doc.title}</h1>${doc.paragraphs
    .map((text) => `<p>${text}</p>`)
    .join("")}</body></html>`;
}

const DATABASE_DOCS_PAGES: Record<string, string> = Object.fromEntries(
  DATABASE_DOCS.flatMap((doc) => doc.urls.map((url) => [url, docsPage(doc)])),
);

function withoutScheme(url: string): string {
  return url.replace(/^https:\/\/(www\.)?/, "");
}

/**
 * Find docs pages as a search engine does. `site:` keeps the pages under that
 * site and path, or else the pages of that host. Pages that share more words
 * with the query come first.
 */
function searchDocs(query: string): WebSearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sites = words
    .filter((word) => word.startsWith("site:"))
    .map((word) => withoutScheme(word.slice("site:".length)));
  const terms = words
    .filter((word) => !word.startsWith("site:"))
    .map((word) => word.replace(/["()]/g, ""))
    .filter((word) => word.length > 2);
  const underSites = (prefixes: string[]) =>
    DATABASE_DOCS.filter((doc) =>
      doc.urls.some((url) =>
        prefixes.some((prefix) => withoutScheme(url).startsWith(prefix)),
      ),
    );
  let docs = DATABASE_DOCS;
  if (sites.length > 0) {
    const onPath = underSites(sites);
    docs =
      onPath.length > 0
        ? onPath
        : underSites(sites.map((site) => site.split("/")[0] ?? site));
  }
  const score = (doc: DocsPage) => {
    const text = `${doc.title} ${doc.urls.join(" ")} ${doc.paragraphs.join(" ")}`;
    return terms.filter((term) => text.toLowerCase().includes(term)).length;
  };
  return [...docs]
    .sort((a, b) => score(b) - score(a))
    .map((doc) => ({
      title: doc.title,
      url: doc.urls[0],
      excerpt: doc.paragraphs[0],
    }));
}

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself.
describe("Implicit Delegation", () => {
  test("when a request splits into independent research tracks, start a child agent for each track", async ({
    agent,
  }) => {
    // A small budget keeps each child short. The case measures the parent's
    // choice to delegate, not the quality of the children's research.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockWebSearchResults(searchDocs);
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
