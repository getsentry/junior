import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as z from "zod";
import { githubSqlSchema } from "./schema.js";

/** Database contract for GitHub-owned projections and reports. */
export type GitHubDb = PgDatabase<PgQueryResultHKT, typeof githubSqlSchema>;

/** Parse the shared database of a plugin context as the GitHub database. */
export const gitHubDbSchema = z.custom<GitHubDb>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "select" in value &&
    "update" in value,
  "Expected a Drizzle Postgres database",
);
