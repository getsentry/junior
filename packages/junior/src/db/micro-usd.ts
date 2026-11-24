/**
 * Postgres stores every money value as whole micro-USD, in a `bigint` column
 * or an integer metric value named `*_micro_usd`. Integer sums are exact and
 * do not depend on row order. Round once where a USD amount is stored, and
 * convert to USD once where the API returns it. `pnpm money-units:check`
 * keeps money scales in this file.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

const MICRO_USD_PER_USD = 1_000_000;

/** Round a USD amount to whole micro-USD for storage. */
export function usdToMicroUsd(usd: number): number {
  return Math.round(usd * MICRO_USD_PER_USD);
}

/**
 * Round a USD amount to whole micro-USD, up with the chance of its fraction.
 * Use it for amounts far below one micro-USD, such as one short embedding
 * call: plain rounding stores zero each time, and this keeps a sum of many
 * amounts right on average.
 */
export function usdToMicroUsdUnbiased(usd: number): number {
  return Math.floor(usd * MICRO_USD_PER_USD + Math.random());
}

/** Convert stored micro-USD to USD for an API response. */
export function microUsdToUsd(microUsd: number): number {
  return microUsd / MICRO_USD_PER_USD;
}

/** SQL that rounds a USD amount to whole micro-USD. */
export function usdToMicroUsdSql(usd: SQL): SQL<number | null> {
  return sql`round(${usd} * 1000000)::bigint`;
}

/** SQL that converts micro-USD to USD, for usage JSON in USD. */
export function microUsdToUsdSql(microUsd: SQL): SQL<number | null> {
  return sql`(${microUsd}) / 1000000.0::double precision`;
}

/**
 * SQL that reads a micro-USD value or sum as an exact integer. Postgres
 * returns `bigint` as text, so this maps it to a number.
 */
export function microUsdSql(microUsd: SQL | AnyPgColumn): SQL<number | null> {
  return sql<number | null>`(${microUsd})::bigint`.mapWith(Number);
}
