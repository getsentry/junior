/**
 * Drizzle source of truth for Google plugin SQL migrations.
 *
 * Update this schema first, then regenerate packaged migrations with
 * `pnpm --filter @sentry/junior-google db:generate`.
 */
import { bigint, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Google accounts that Junior acts as.
 *
 * One row per connected account email. The refresh token is a long-lived
 * secret: never log it, return it from routes, or expose it to the sandbox.
 */
export const juniorGoogleAccounts = pgTable("junior_google_accounts", {
  accountEmail: text("account_email").primaryKey(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  connectedBy: text("connected_by").notNull(),
  connectedAtMs: bigint("connected_at_ms", { mode: "number" }).notNull(),
});
