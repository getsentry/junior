import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as googleSqlSchema from "./db/schema";
import { juniorGoogleAccounts } from "./db/schema";

export type GoogleDb = PgDatabase<PgQueryResultHKT, typeof googleSqlSchema>;

export type GoogleAccountRecord = typeof juniorGoogleAccounts.$inferSelect;

/** Account details that are safe to show to an admin. Never includes tokens. */
export interface GoogleAccountStatus {
  accountEmail: string;
  connectedAt: string;
  connectedBy: string;
  scope: string;
}

/** Read the stored connection for one account email. */
export async function getGoogleAccount(
  db: GoogleDb,
  accountEmail: string,
): Promise<GoogleAccountRecord | undefined> {
  const [row] = await db
    .select()
    .from(juniorGoogleAccounts)
    .where(eq(juniorGoogleAccounts.accountEmail, accountEmail))
    .limit(1);
  return row;
}

/** Create or replace the stored connection for one account email. */
export async function saveGoogleAccount(
  db: GoogleDb,
  record: GoogleAccountRecord,
): Promise<void> {
  await db
    .insert(juniorGoogleAccounts)
    .values(record)
    .onConflictDoUpdate({
      target: juniorGoogleAccounts.accountEmail,
      set: {
        refreshToken: record.refreshToken,
        scope: record.scope,
        connectedBy: record.connectedBy,
        connectedAtMs: record.connectedAtMs,
      },
    });
}

/**
 * Remove a connection after Google rejects its refresh token.
 *
 * The token match keeps a concurrent reconnect from being deleted.
 */
export async function deleteRejectedGoogleAccount(
  db: GoogleDb,
  record: Pick<GoogleAccountRecord, "accountEmail" | "refreshToken">,
): Promise<void> {
  await db
    .delete(juniorGoogleAccounts)
    .where(
      and(
        eq(juniorGoogleAccounts.accountEmail, record.accountEmail),
        eq(juniorGoogleAccounts.refreshToken, record.refreshToken),
      ),
    );
}

/** Project a stored connection into admin-safe status fields. */
export function googleAccountStatus(
  record: GoogleAccountRecord,
): GoogleAccountStatus {
  return {
    accountEmail: record.accountEmail,
    connectedAt: new Date(record.connectedAtMs).toISOString(),
    connectedBy: record.connectedBy,
    scope: record.scope,
  };
}
