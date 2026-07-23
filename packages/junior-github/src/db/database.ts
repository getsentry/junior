import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { githubSqlSchema } from "./schema.js";

/** Database contract for GitHub-owned projections and reports. */
export type GitHubDb = PgDatabase<PgQueryResultHKT, typeof githubSqlSchema>;
