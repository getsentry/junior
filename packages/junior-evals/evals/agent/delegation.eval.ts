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

const MYSQL_ADD_COLUMN_LIMITS =
  "Columns cannot be added to tables that use ROW_FORMAT=COMPRESSED, tables with a FULLTEXT index, tables that reside in the data dictionary tablespace, or temporary tables. Temporary tables only support ALGORITHM=COPY. A new row version is created after each ALTER TABLE ... ALGORITHM=INSTANT operation that adds one or more columns, drops one or more columns, or adds and drops one or more columns in the same operation. When the row version limit is reached, ADD COLUMN and DROP COLUMN operations using ALGORITHM=INSTANT are rejected with an error message that recommends rebuilding the table using the COPY or INPLACE algorithm.";
const PG_LOCK_TIMEOUT =
  "lock_timeout: Abort any statement that waits longer than the specified amount of time while attempting to acquire a lock on a table, index, row, or other database object. The time limit applies separately to each lock acquisition attempt.";
const PG_STREAMING_REPLICATION =
  "Streaming replication allows a standby server to stay more up-to-date than is possible with file-based log shipping. The standby connects to the primary, which streams WAL records to the standby as they're generated, without waiting for the WAL file to be filled.";
const PG_LOGICAL_REPLICATION =
  "The database schema and DDL commands are not replicated. The initial schema can be copied by hand using pg_dump --schema-only. Subsequent schema changes would need to be kept in sync manually.";
const MYSQL_ALGORITHM_AND_LOCK =
  "If the ALGORITHM clause is omitted, MySQL uses ALGORITHM=INSTANT for storage engines and ALTER TABLE clauses that support it. Otherwise, ALGORITHM=INPLACE is used. If ALGORITHM=INPLACE is not supported, ALGORITHM=COPY is used. Only LOCK = DEFAULT is permitted for operations that use ALGORITHM=INSTANT.";
const MYSQL_METADATA_LOCKS =
  "An exclusive metadata lock on the table may be taken briefly during the execution phase of the operation. Due to the exclusive metadata lock requirements outlined above, an online DDL operation may have to wait for concurrent transactions that hold metadata locks on the table to commit or rollback. In the case of a long running or inactive transaction, an online DDL operation can time out waiting for an exclusive metadata lock. Additionally, a pending exclusive metadata lock requested by an online DDL operation blocks subsequent transactions on the table.";
const MYSQL_REPLICATION_LAG =
  "Long running online DDL operations can cause replication lag. An online DDL operation must finish running on the source before it is run on the replica. Also, DML that was processed concurrently on the source is only processed on the replica after the DDL operation on the replica is completed.";
const SQLITE_WRITE_LOCK =
  "An EXCLUSIVE lock is needed in order to write to the database file. Only one EXCLUSIVE lock is allowed on the file and no other locks of any kind are allowed to coexist with an EXCLUSIVE lock. In order to maximize concurrency, SQLite works to minimize the amount of time that EXCLUSIVE locks are held.";
const SQLITE_WAL =
  "WAL provides more concurrency as readers do not block writers and a writer does not block readers. Reading and writing can proceed concurrently. However, since there is only one WAL file, there can only be one writer at a time.";
const SQLITE_ONE_WRITER =
  "SQLite supports multiple simultaneous read transactions coming from separate database connections, possibly in separate threads or processes, but only one simultaneous write transaction.";
const SQLITE_BACKUP =
  "The online backup API allows the contents of one database to be copied into another database file, replacing any original contents of the target database. The copy operation may be done incrementally, in which case the source database does not need to be locked for the duration of the copy, only for the brief periods of time when it is actually being read from.";
const SQLITE_RSYNC =
  "The following command causes REPLICA to become a copy of ORIGIN: $ sqlite3_rsync ORIGIN REPLICA ?OPTIONS? Both databases may be live while this utility is running. Other programs can have active connections to the databases on either end while this utility is running.";
const PG_FAST_DEFAULT_RELEASE =
  "Allow ALTER TABLE to add a column with a non-null default without doing a table rewrite (Andrew Dunstan, Serge Rielau). This is enabled when the default value is a constant.";
const MYSQL_DDL_PERFORMANCE =
  "The performance of a DDL operation is largely determined by whether the operation is performed instantly, in place, and whether it rebuilds the table.";
const MYSQL_INTERMEDIATE_TABLE =
  "Some online DDL operations that rebuild the table create a temporary intermediate table file in the same directory as the original table. An intermediate table file may require space equal to the size of the original table. Intermediate table file names begin with #sql-ib prefix and only appear briefly during the online DDL operation.";
const MYSQL_DDL_BINLOG =
  "With the binary log format set to ROW, many changes are written to the binary log using the row-based format. Some changes, however, still use the statement-based format. Examples include all DDL (data definition language) statements such as CREATE TABLE, ALTER TABLE, or DROP TABLE.";
const MYSQL_EXPRESSION_DEFAULT_REPLICATION =
  "If an expression default value refers to a nondeterministic function, any statement that causes the expression to be evaluated is unsafe for statement-based replication. This includes statements such as INSERT and UPDATE.";
const SQLITE_SESSION =
  'The session extension provides a convenient mechanism to record changes to tables in an SQLite database, package those changes into a "changeset" or "patchset" file, and later apply the same set of changes to another database with the same schema and compatible starting data.';
const MYSQL_ADD_COLUMN_REBUILD =
  "Concurrent DML is not permitted when adding an auto-increment column. Data is reorganized substantially, making it an expensive operation. At a minimum, ALGORITHM=INPLACE, LOCK=SHARED is required. The table is rebuilt if ALGORITHM=INPLACE is used to add a column.";

// Fixed docs pages answer at once. The case measures the parent's choice to
// delegate, and the children's research is not checked, so live docs pages
// only make the run slow. The pages are the ones that the parent's tasks name
// and that the children read or search for in replays of earlier runs. All
// text is sentences from the real docs of each project, so a quote that an
// agent checks against the live docs matches. The main page of each database
// also has the sentences of the related pages that answer its child's whole
// task, so one read is enough. The first paragraph is also the search
// excerpt. Other paths on these sites get 404.
const DATABASE_DOCS: DocsPage[] = [
  {
    title: "PostgreSQL: Documentation: ALTER TABLE",
    urls: ["https://www.postgresql.org/docs/current/sql-altertable.html"],
    paragraphs: [
      "When a column is added with ADD COLUMN and a non-volatile DEFAULT is specified, the default value is evaluated at the time of the statement and the result stored in the table's metadata, where it will be returned when any existing rows are accessed. The value will be only applied when the table is rewritten, making the ALTER TABLE very fast even on large tables. If no column constraints are specified, NULL is used as the DEFAULT. In neither case is a rewrite of the table required.",
      "Adding a column with a volatile DEFAULT (e.g., clock_timestamp()), a stored generated column, an identity column, or a column with a domain data type that has constraints will cause the entire table and its indexes to be rewritten. Adding a virtual generated column never requires a rewrite.",
      "Note that the lock level required may differ for each subform. An ACCESS EXCLUSIVE lock is acquired unless explicitly noted. When multiple subcommands are given, the lock acquired will be the strictest one required by any subcommand.",
      "Adding a CHECK or NOT NULL constraint requires scanning the table to verify that existing rows meet the constraint, but does not require a table rewrite. After a table rewrite, the table will appear empty to concurrent transactions, if they are using a snapshot taken before the rewrite occurred.",
      "ACCESS EXCLUSIVE conflicts with locks of all modes. Only an ACCESS EXCLUSIVE lock blocks a SELECT (without FOR UPDATE/SHARE) statement.",
      PG_FAST_DEFAULT_RELEASE,
      PG_LOCK_TIMEOUT,
      PG_STREAMING_REPLICATION,
      PG_LOGICAL_REPLICATION,
    ],
  },
  {
    title: "PostgreSQL: Documentation: 11: Release 11",
    urls: [
      "https://www.postgresql.org/docs/11/release-11.html",
      "https://www.postgresql.org/docs/release/11.0/",
    ],
    paragraphs: [PG_FAST_DEFAULT_RELEASE],
  },
  {
    title: "PostgreSQL: Documentation: Explicit Locking",
    urls: ["https://www.postgresql.org/docs/current/explicit-locking.html"],
    paragraphs: [
      "ACCESS EXCLUSIVE (AccessExclusiveLock): Conflicts with locks of all modes (ACCESS SHARE, ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, and ACCESS EXCLUSIVE). This mode guarantees that the holder is the only transaction accessing the table in any way. Many forms of ALTER INDEX and ALTER TABLE also acquire a lock at this level.",
      "Tip: Only an ACCESS EXCLUSIVE lock blocks a SELECT (without FOR UPDATE/SHARE) statement.",
    ],
  },
  {
    title: "PostgreSQL: Documentation: Logical Replication Restrictions",
    urls: [
      "https://www.postgresql.org/docs/current/logical-replication-restrictions.html",
    ],
    paragraphs: [
      PG_LOGICAL_REPLICATION,
      "When the schema is changed on the publisher and replicated data starts arriving at the subscriber but does not fit into the table schema, replication will error until the schema is updated. In many cases, intermittent errors can be avoided by applying additive schema changes to the subscriber first.",
    ],
  },
  {
    title: "PostgreSQL: Documentation: Client Connection Defaults",
    urls: [
      "https://www.postgresql.org/docs/current/runtime-config-client.html",
    ],
    paragraphs: [PG_LOCK_TIMEOUT],
  },
  {
    title: "PostgreSQL: Documentation: Log-Shipping Standby Servers",
    urls: ["https://www.postgresql.org/docs/current/warm-standby.html"],
    paragraphs: [PG_STREAMING_REPLICATION],
  },
  {
    title: "MySQL :: MySQL 8.4 Reference Manual :: Online DDL Operations",
    urls: [
      "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html",
    ],
    paragraphs: [
      "Adding a column: ALTER TABLE tbl_name ADD COLUMN column_name column_definition, ALGORITHM=INSTANT; INSTANT is the default algorithm in MySQL 8.4. Online DDL support: Instant: Yes. In Place: Yes. Rebuilds Table: No. Permits Concurrent DML: Yes. Only Modifies Metadata: Yes. A statement cannot combine the addition of a column with other ALTER TABLE actions that do not support the INSTANT algorithm. The INSTANT algorithm can add a column at any position in the table.",
      `${MYSQL_ADD_COLUMN_LIMITS} The maximum number of row versions permitted is 64 (255 as of MySQL 9.1.0), as each row version requires additional space for table metadata.`,
      MYSQL_ADD_COLUMN_REBUILD,
      "INSTANT is the default algorithm as of MySQL 8.0.12, and INPLACE before that. Before MySQL 8.0.29, the INSTANT algorithm could only add a column as the last column of the table.",
      MYSQL_ALGORITHM_AND_LOCK,
      MYSQL_METADATA_LOCKS,
      MYSQL_DDL_PERFORMANCE,
      MYSQL_INTERMEDIATE_TABLE,
      MYSQL_REPLICATION_LAG,
      MYSQL_DDL_BINLOG,
      MYSQL_EXPRESSION_DEFAULT_REPLICATION,
    ],
  },
  {
    title: "MySQL :: MySQL 8.0 Reference Manual :: Online DDL Operations",
    urls: [
      "https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl-operations.html",
    ],
    paragraphs: [
      "Adding a column: ALTER TABLE tbl_name ADD COLUMN column_name column_definition, ALGORITHM=INSTANT; INSTANT is the default algorithm as of MySQL 8.0.12, and INPLACE before that. Online DDL support: Instant: Yes. In Place: Yes. Rebuilds Table: No. Permits Concurrent DML: Yes. Only Modifies Metadata: Yes. The INSTANT algorithm can add a column at any position in the table. Before MySQL 8.0.29, the INSTANT algorithm could only add a column as the last column of the table.",
      `${MYSQL_ADD_COLUMN_LIMITS} The maximum number of row versions permitted is 64, as each row version requires additional space for table metadata.`,
      MYSQL_ADD_COLUMN_REBUILD,
    ],
  },
  {
    title:
      "MySQL :: MySQL 8.4 Reference Manual :: Online DDL Performance and Concurrency",
    urls: [
      "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-performance.html",
    ],
    paragraphs: [MYSQL_DDL_PERFORMANCE, MYSQL_METADATA_LOCKS],
  },
  {
    title: "MySQL :: MySQL 8.4 Reference Manual :: Online DDL Limitations",
    urls: [
      "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-limitations.html",
    ],
    paragraphs: [MYSQL_REPLICATION_LAG],
  },
  {
    title: "MySQL :: MySQL 8.4 Reference Manual :: ALTER TABLE Statement",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/alter-table.html"],
    paragraphs: [
      MYSQL_ALGORITHM_AND_LOCK,
      "For ALTER TABLE operations that support it, you can use the LOCK clause to control the level of concurrent reads and writes on a table while it is being altered. LOCK = DEFAULT: Maximum level of concurrency for the given ALGORITHM clause (if any) and ALTER TABLE operation: Permit concurrent reads and writes if supported.",
    ],
  },
  {
    title:
      "MySQL :: MySQL 8.4 Reference Manual :: Replication Features and Issues",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/replication-features.html"],
    paragraphs: [
      "Statement-based replication depends on compatibility at the SQL level between the source and replica. In other words, successful statement-based replication requires that any SQL features used be supported by both the source and the replica servers.",
      MYSQL_REPLICATION_LAG,
    ],
  },
  {
    title:
      "MySQL :: MySQL 8.4 Reference Manual :: Online DDL Space Requirements",
    urls: [
      "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-space-requirements.html",
    ],
    paragraphs: [MYSQL_INTERMEDIATE_TABLE],
  },
  {
    title:
      "MySQL :: MySQL 8.4 Reference Manual :: Setting The Binary Log Format",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/binary-log-setting.html"],
    paragraphs: [MYSQL_DDL_BINLOG],
  },
  {
    title: "MySQL :: MySQL 8.4 Reference Manual :: Data Type Default Values",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html"],
    paragraphs: [
      "The default value specified in a DEFAULT clause can be a literal constant or an expression. With one exception, enclose expression default values within parentheses to distinguish them from literal constant default values.",
      MYSQL_EXPRESSION_DEFAULT_REPLICATION,
    ],
  },
  {
    title: "MySQL :: MySQL 8.4 Reference Manual :: InnoDB and Online DDL",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl.html"],
    paragraphs: [
      "The online DDL feature provides support for instant and in-place table alterations and concurrent DML. Typically, you do not need to do anything special to enable online DDL. By default, MySQL performs the operation instantly or in place, as permitted, with as little locking as possible.",
    ],
  },
  {
    title: "MySQL :: MySQL 8.4 Reference Manual :: Metadata Locking",
    urls: ["https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html"],
    paragraphs: [
      "The server achieves this by acquiring metadata locks on tables used within a transaction and deferring release of those locks until the transaction ends. A metadata lock on a table prevents changes to the table's structure. This locking approach has the implication that a table that is being used by a transaction within one session cannot be used in DDL statements by other sessions until the transaction ends.",
    ],
  },
  {
    title: "ALTER TABLE",
    urls: [
      "https://www.sqlite.org/lang_altertable.html",
      "https://sqlite.org/lang_altertable.html",
    ],
    paragraphs: [
      "The ALTER TABLE command works by modifying the SQL text of the schema stored in the sqlite_schema table. No changes are made to table content for renames or column addition without constraints. Because of this, the execution time of such ALTER TABLE commands is independent of the amount of data in the table and such commands will run as quickly on a table with 10 million rows as on a table with 1 row.",
      "The ADD COLUMN syntax is used to add a new column to an existing table. The column may not have a PRIMARY KEY or UNIQUE constraint. The column may not have a default value of CURRENT_TIME, CURRENT_DATE, CURRENT_TIMESTAMP, or an expression in parentheses. If a NOT NULL constraint is specified, then the column must have a default value other than NULL. The column may not be GENERATED ALWAYS ... STORED, though VIRTUAL columns are allowed.",
      "When adding a column with a CHECK constraint, or a NOT NULL constraint on a generated column, the added constraints are tested against all preexisting rows in the table and the ADD COLUMN fails if any constraint fails. The testing of added constraints against preexisting rows is a new enhancement as of SQLite version 3.37.0 (2021-11-27).",
      'The only schema altering commands directly supported by SQLite are the rename table, rename column, add column, drop column commands shown above. However, applications can make other arbitrary changes to the format of a table using a simple sequence of operations. Start a transaction. Use CREATE TABLE to construct a new table "new_X" that is in the desired revised format of table X. Transfer content from X into new_X using a statement like: INSERT INTO new_X SELECT ... FROM X. Drop the old table X: DROP TABLE X. Change the name of new_X to X using: ALTER TABLE new_X RENAME TO X. Commit the transaction.',
      SQLITE_WRITE_LOCK,
      SQLITE_WAL,
      SQLITE_ONE_WRITER,
      SQLITE_BACKUP,
      SQLITE_RSYNC,
      SQLITE_SESSION,
    ],
  },
  {
    title: "File Locking And Concurrency In SQLite Version 3",
    urls: ["https://www.sqlite.org/lockingv3.html"],
    paragraphs: [
      SQLITE_WRITE_LOCK,
      "A RESERVED lock means that the process is planning on writing to the database file at some point in the future but that it is currently just reading from the file. Only a single RESERVED lock may be active at one time, though multiple SHARED locks can coexist with a single RESERVED lock.",
    ],
  },
  {
    title: "Write-Ahead Logging",
    urls: ["https://www.sqlite.org/wal.html"],
    paragraphs: [SQLITE_WAL],
  },
  {
    title: "SQLite Backup API",
    urls: ["https://www.sqlite.org/backup.html"],
    paragraphs: [SQLITE_BACKUP],
  },
  {
    title: "The sqlite3_rsync Utility",
    urls: ["https://www.sqlite.org/rsync.html"],
    paragraphs: [SQLITE_RSYNC],
  },
  {
    title: "Transaction",
    urls: ["https://www.sqlite.org/lang_transaction.html"],
    paragraphs: [
      `${SQLITE_ONE_WRITER} A read transaction is started by a SELECT statement, and a write transaction is started by statements like CREATE, DELETE, DROP, INSERT, or UPDATE (collectively "write statements").`,
    ],
  },
  {
    title: "SQLite Session Module C/C++ Interface",
    urls: ["https://www.sqlite.org/session.html"],
    paragraphs: [
      "This page defines the C-language interface to the SQLite session extension.",
    ],
  },
  {
    title: "The Session Extension",
    urls: ["https://www.sqlite.org/sessionintro.html"],
    paragraphs: [SQLITE_SESSION],
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

// A `site:` value often has no scheme. Drop the scheme and `www.` separately.
function withoutScheme(url: string): string {
  return url.replace(/^(?:https?:\/\/)?(?:www\.)?/, "");
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
