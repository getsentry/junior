import { and, eq, lt, ne } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubInstallations } from "../db/schema.js";

const table = juniorGitHubInstallations;

/** One active App installation and the account it is installed on. */
export interface GitHubInstallation {
  installationId: number;
  /** Account login. It is stored in lowercase. */
  accountLogin: string;
}

/** Read the installation on one account, or undefined when there is none. */
export async function findGitHubInstallationId(
  db: GitHubDb,
  accountLogin: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ installationId: table.installationId })
    .from(table)
    .where(eq(table.accountLogin, accountLogin.toLowerCase()))
    .limit(1);
  return row?.installationId;
}

/**
 * Save one installation, such as from an `installation` webhook. A row for
 * another installation with the same login is stale after a rename, so it is
 * removed.
 */
export async function saveGitHubInstallation(
  db: GitHubDb,
  installation: GitHubInstallation,
): Promise<void> {
  const accountLogin = installation.accountLogin.toLowerCase();
  await db.transaction(async (tx) => {
    await tx
      .delete(table)
      .where(
        and(
          eq(table.accountLogin, accountLogin),
          ne(table.installationId, installation.installationId),
        ),
      );
    await tx
      .insert(table)
      .values({
        installationId: installation.installationId,
        accountLogin,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: table.installationId,
        set: { accountLogin, updatedAt: new Date() },
      });
  });
}

/** Remove an installation that was deleted or suspended. */
export async function deleteGitHubInstallation(
  db: GitHubDb,
  installationId: number,
): Promise<void> {
  await db.delete(table).where(eq(table.installationId, installationId));
}

/**
 * Apply the complete list of active installations that GitHub returned for a
 * request sent at `listedAt`. A row written after `listedAt`, such as by an
 * `installation` webhook while the request ran, is newer than the list. It
 * stays, and a listed installation with the same id or login is skipped.
 */
export async function syncGitHubInstallations(
  db: GitHubDb,
  installations: GitHubInstallation[],
  listedAt: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(table).where(lt(table.updatedAt, listedAt));
    if (installations.length === 0) return;
    await tx
      .insert(table)
      .values(
        installations.map((installation) => ({
          installationId: installation.installationId,
          accountLogin: installation.accountLogin.toLowerCase(),
          updatedAt: listedAt,
        })),
      )
      .onConflictDoNothing();
  });
}
