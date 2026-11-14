import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as sentrySqlSchema from "./schema.js";

/** Database contract for Sentry-owned installation records. */
export type SentryDb = PgDatabase<PgQueryResultHKT, typeof sentrySqlSchema>;
