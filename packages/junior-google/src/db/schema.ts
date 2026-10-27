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

/**
 * Working hours that people save for themselves with `setWorkingHours`.
 *
 * Google Calendar does not expose the working hours people set in Calendar,
 * so Junior keeps its own copy. One row per work email. Times are 24-hour
 * `HH:MM` in the person's own calendar time zone.
 */
export const juniorGoogleWorkingHours = pgTable("junior_google_working_hours", {
  email: text("email").primaryKey(),
  workdayStart: text("workday_start").notNull(),
  workdayEnd: text("workday_end").notNull(),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
});
