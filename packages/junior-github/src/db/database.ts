import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as z from "zod";

/** Database contract for GitHub-owned projections and reports. */
export type GitHubDb = PgAsyncDatabase<PgQueryResultHKT>;

/** Parse the shared database of a plugin context as the GitHub database. */
export const gitHubDbSchema = z.custom<GitHubDb>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "select" in value &&
    "update" in value,
  "Expected a Drizzle Postgres database",
);
