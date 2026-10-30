import { and, eq, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
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

/**
 * Mark an installation as removed, such as after an uninstall or suspend.
 * The row stays without a login, so a sync with an older list skips it.
 */
export async function removeGitHubInstallation(
  db: GitHubDb,
  installationId: number,
): Promise<void> {
  const updatedAt = new Date();
  await db
    .insert(table)
    .values({ installationId, accountLogin: null, updatedAt })
    .onConflictDoUpdate({
      target: table.installationId,
      set: { accountLogin: null, updatedAt },
    });
}

/**
 * Apply the complete list of active installations that GitHub returned for a
 * request sent at `listedAt`. A row written after `listedAt`, such as by an
 * `installation` webhook or a later sync, is newer than the list. It stays,
 * and a listed installation with the same id or login is skipped. Older rows
 * that the list omits are marked as removed.
 */
export async function syncGitHubInstallations(
  db: GitHubDb,
  installations: GitHubInstallation[],
  listedAt: Date,
): Promise<void> {
  const rows = installations.map((installation) => ({
    installationId: installation.installationId,
    accountLogin: installation.accountLogin.toLowerCase(),
    updatedAt: listedAt,
  }));
  const older = lt(table.updatedAt, listedAt);
  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx.delete(table).where(
        and(
          older,
          or(
            inArray(
              table.installationId,
              rows.map((row) => row.installationId),
            ),
            inArray(
              table.accountLogin,
              rows.map((row) => row.accountLogin),
            ),
          ),
        ),
      );
    }
    await tx
      .update(table)
      .set({ accountLogin: null, updatedAt: listedAt })
      .where(and(older, isNotNull(table.accountLogin)));
    if (rows.length > 0) {
      await tx.insert(table).values(rows).onConflictDoNothing();
    }
  });
}
