/**
 * GitHub `issueCredential` hook behavior.
 *
 * This module selects the credential for each GitHub grant. It resolves App
 * installations from the stored table and repairs that table from GitHub.
 */
import type {
  IssueCredentialHookContext,
  PluginCache,
  PluginCredentialResult,
} from "@sentry/junior-plugin-api";
import {
  credentialUnavailable,
  type GitHubAppEnv,
  GitHubPluginSetupError,
  isInactiveInstallationError,
  issueInstallationLease,
  issueUserCredential,
  listActiveInstallations,
  readAppOwnerLogin,
  USER_TOKEN_GRANTS,
  type UserCredentialOptions,
} from "./credential-support.js";
import type { GitHubDb } from "./db/database.js";
import { ownerFromLeaseScope } from "./installation-targets.js";
import {
  removeGitHubInstallation,
  findGitHubInstallationId,
  syncGitHubInstallations,
} from "./installations/store.js";

// `installation` webhooks keep stored installations current. A sync only
// repairs missed ones, so a short interval bounds GitHub calls on misses.
const INSTALLATIONS_SYNC_INTERVAL_MS = 60 * 1000;

/**
 * Sync the stored installations with the active ones that GitHub lists.
 * This fills the table on first use and repairs missed `installation`
 * webhooks. It runs at most once per `INSTALLATIONS_SYNC_INTERVAL_MS`, unless
 * `refresh` asks for a new list.
 */
async function syncInstallations(
  app: GitHubAppEnv,
  db: GitHubDb,
  cache: PluginCache,
  options?: { refresh?: boolean },
): Promise<void> {
  await cache.getOrLoad(
    "installations-synced",
    async () => {
      const listedAt = new Date();
      const active = await listActiveInstallations(app);
      await syncGitHubInstallations(db, active, listedAt);
      return { value: true, ttlMs: INSTALLATIONS_SYNC_INTERVAL_MS };
    },
    options,
  );
}

/** Read the installation on one account, and sync once when none is stored. */
async function installationIdFor(
  accountLogin: string,
  app: GitHubAppEnv,
  ctx: IssueCredentialHookContext,
): Promise<number | undefined> {
  const db = ctx.db as GitHubDb;
  const stored = await findGitHubInstallationId(db, accountLogin);
  if (stored) return stored;
  await syncInstallations(app, db, ctx.cache);
  return await findGitHubInstallationId(db, accountLogin);
}

/**
 * Resolve the App installation for an installation grant from the owner in
 * its lease scope. Writes need the owner's own installation. Reads without
 * one, or without an owner, use the App owner's installation, which can still
 * read public repositories.
 */
async function resolveInstallationId(
  ctx: IssueCredentialHookContext,
  app: GitHubAppEnv,
): Promise<number> {
  const owner = ownerFromLeaseScope(ctx.grant.leaseScope);
  if (owner) {
    const id = await installationIdFor(owner, app, ctx);
    if (id) return id;
    if (ctx.grant.access === "write") {
      throw new GitHubPluginSetupError(
        `The GitHub App is not installed on ${owner}.`,
      );
    }
  }
  const appOwner = await readAppOwnerLogin(app, ctx.cache);
  const defaultId = await installationIdFor(appOwner, app, ctx);
  if (!defaultId) {
    throw new GitHubPluginSetupError(
      `The GitHub App is not installed on ${appOwner}, the account that owns it.`,
    );
  }
  return defaultId;
}

interface GitHubCredentialOptions extends GitHubAppEnv, UserCredentialOptions {
  /** Declared read permissions. Omit to read the installed ones. */
  readPermissions?: Record<string, "read">;
}

/**
 * Issue the lease for an installation grant. A stored installation can be
 * stale when Junior missed its uninstall or suspend webhook. When GitHub
 * rejects it, mark the row as removed, sync from GitHub, and try once more.
 */
async function issueInstallationCredential(
  ctx: IssueCredentialHookContext,
  options: GitHubCredentialOptions,
): Promise<PluginCredentialResult> {
  const db = ctx.db as GitHubDb;
  for (let attempt = 1; ; attempt += 1) {
    const installationId = await resolveInstallationId(ctx, options);
    try {
      return await issueInstallationLease({
        app: options,
        cache: ctx.cache,
        installationId,
        access: ctx.grant.name === "installation-read" ? "read" : "write",
        readPermissions: options.readPermissions,
      });
    } catch (error) {
      if (!isInactiveInstallationError(error)) throw error;
      await removeGitHubInstallation(db, installationId);
      if (attempt > 1) {
        throw new GitHubPluginSetupError(
          `The GitHub App installation ${installationId} is no longer active.`,
        );
      }
      await syncInstallations(options, db, ctx.cache, { refresh: true });
    }
  }
}

/**
 * Issue the credential for one GitHub grant that host egress selected. Only
 * the `issueCredential` hook may call this. Other code reads and writes GitHub
 * through host egress.
 */
export async function issueGitHubCredential(
  ctx: IssueCredentialHookContext,
  options: GitHubCredentialOptions,
): Promise<PluginCredentialResult> {
  try {
    if (
      ctx.grant.name === "installation-read" ||
      ctx.grant.name === "installation-write"
    ) {
      return await issueInstallationCredential(ctx, options);
    }
    if (USER_TOKEN_GRANTS.has(ctx.grant.name)) {
      return await issueUserCredential(ctx, options);
    }
  } catch (error) {
    if (error instanceof GitHubPluginSetupError) {
      return credentialUnavailable(error.message);
    }
    throw error;
  }
  throw new Error(
    `GitHub plugin cannot issue unknown grant "${ctx.grant.name}".`,
  );
}
