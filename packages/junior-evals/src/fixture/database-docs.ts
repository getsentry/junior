/**
 * Real docs of PostgreSQL, MySQL, and SQLite for tests where agents research
 * databases on the web.
 *
 * There is one real docs page for each database. Each file is the live page
 * with the scripts, styles, and parts that `webFetch` does not read taken
 * out. It is cut after the first 12,000 characters, which is the most that
 * `webFetch` returns. `webFetch` returns the same text for these files as for
 * the live pages.
 */
import { readFileSync } from "node:fs";
import {
  mockWebSearchResults,
  mockWebSites,
  type WebSearchResult,
} from "./web";

const DATABASE_DOCS = [
  {
    host: "postgresql.org",
    file: "postgresql-alter-table.html",
    url: "https://www.postgresql.org/docs/current/sql-altertable.html",
    title: "PostgreSQL: Documentation: 18: ALTER TABLE",
    excerpt: "ALTER TABLE — change the definition of a table",
  },
  {
    host: "dev.mysql.com",
    file: "mysql-online-ddl-operations.html",
    url: "https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html",
    title:
      "MySQL :: MySQL 8.4 Reference Manual :: 17.12.1 Online DDL Operations",
    excerpt:
      "Online support details, syntax examples, and usage notes for DDL operations are provided under the following topics in this section.",
  },
  {
    host: "sqlite.org",
    file: "sqlite-alter-table.html",
    url: "https://www.sqlite.org/lang_altertable.html",
    title: "ALTER TABLE",
    excerpt: "SQLite supports a limited subset of ALTER TABLE.",
  },
];

/**
 * Return the docs pages, or only those on the hosts of `site:` filters. As on
 * a search engine, a site also matches its subdomains.
 */
function searchDatabaseDocs(query: string): WebSearchResult[] {
  const sites = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.startsWith("site:"))
    .map(
      (word) =>
        word
          .slice("site:".length)
          .replace(/^(?:https?:\/\/)?(?:www\.)?/, "")
          .split("/")[0],
    );
  return DATABASE_DOCS.filter(
    (doc) =>
      sites.length === 0 ||
      sites.some((site) => doc.host === site || doc.host.endsWith(`.${site}`)),
  ).map(({ excerpt, title, url }) => ({ excerpt, title, url }));
}

/**
 * Serve the database docs in this test. A search finds the three pages, and
 * a read of any path on a docs host gets the page of that host.
 */
export function mockDatabaseDocs(): void {
  mockWebSearchResults(searchDatabaseDocs);
  mockWebSites(
    Object.fromEntries(
      DATABASE_DOCS.map((doc) => [
        doc.host,
        readFileSync(
          new URL(`./database-docs/${doc.file}`, import.meta.url),
          "utf8",
        ),
      ]),
    ),
  );
}
