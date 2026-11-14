/**
 * Drizzle source of truth for Sentry plugin SQL migrations.
 *
 * Update this schema first, then regenerate packaged migrations with
 * `pnpm --filter @sentry/junior-sentry db:generate`.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Installations of Junior's Sentry public integration. A Sentry org has at
 * most one installation of an integration, so the org slug finds the
 * installation for a request. `installation` webhooks write the rows. Sentry
 * has no API that lists them again, so this table is the only record.
 */
export const juniorSentryInstallations = pgTable(
  "junior_sentry_installations",
  {
    installationUuid: text("installation_uuid").primaryKey(),
    /**
     * Lowercase slug of the org that installed the integration. It is null
     * after the integration is uninstalled. The row stays, so a late retry
     * of the install webhook cannot add the installation again.
     */
    orgSlug: text("org_slug").unique(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
);
