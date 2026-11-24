/**
 * Service accounts.
 *
 * A plugin's `accounts` block can allow an optional install-wide provider
 * account, often a bot, that Junior itself uses. By default, the credential
 * order for one request is:
 *
 * 1. The Actor's own connection, when it exists.
 * 2. The plugin's service account, when an Admin connected it and
 *    `accounts.service-account` lists what the request uses.
 * 3. Otherwise, the Actor must connect their own account.
 *
 * With `accounts.user-oauth: false`, Junior uses only the service account.
 * It ignores Actor connections, never asks an Actor to connect, and hides
 * what the account does not list. Until an Admin connects the account, the
 * plugin is not available.
 *
 * This module is the one place that decides which requests the service
 * account may serve. Each request surface asks it before it uses the shared
 * account. An MCP plugin lists the MCP tools it may call. A plugin with a
 * top-level `oauth` block lists the operations that its host code passes to
 * `egress.fetch`. Sandbox egress names no operation, so commands that the
 * model writes never get the shared account.
 *
 * This module also owns the connect flow that the dashboard Admin page and
 * the `junior service-account` CLI share. The MCP surface stores MCP OAuth
 * state, and the OAuth surface stores provider tokens.
 */
import {
  deleteMcpServiceAccountCredentials,
  finishMcpServiceAccountSignIn,
  getMcpServiceAccountCredentials,
  startMcpServiceAccountSignIn,
} from "@/chat/mcp/service-account";
import {
  deleteOAuthServiceAccountCredentials,
  finishOAuthServiceAccountSignIn,
  getOAuthServiceAccountCredentials,
  startOAuthServiceAccountSignIn,
} from "@/chat/plugins/auth/oauth-service-account";
import type { PluginDefinition, PluginManifest } from "@/chat/plugins/types";

/** One request that a plugin's service account could serve. */
export type ServiceAccountRequest =
  /** Provider MCP tool that the request calls. */
  | { tool: string }
  /** Operation that plugin host code passed to `egress.fetch`. */
  | { operation: string };

/** Return whether the plugin's service account may serve this request. */
export function serviceAccountAllows(
  manifest: Pick<PluginManifest, "accounts">,
  request: ServiceAccountRequest,
): boolean {
  const serviceAccount = manifest.accounts?.serviceAccount;
  return "tool" in request
    ? (serviceAccount?.tools?.includes(request.tool) ?? false)
    : (serviceAccount?.operations?.includes(request.operation) ?? false);
}

/**
 * Return whether the plugin uses only its service account.
 *
 * Then no surface may fall back to an Actor's own connection or ask an
 * Actor to connect.
 */
export function serviceAccountOnly(
  manifest: Pick<PluginManifest, "accounts">,
): boolean {
  return manifest.accounts?.userOAuth === false;
}

/** Admin-safe status of one plugin's service account. Never includes tokens. */
export interface ServiceAccountStatus {
  provider: string;
  displayName: string;
  /** False when Actors cannot use their own connection. */
  userOAuth: boolean;
  /** MCP tools that the account may call. */
  tools: string[];
  /** `egress.fetch` operations that the account may serve. */
  operations: string[];
  connected: boolean;
  connectedAt?: string;
  /** Email of the Admin who connected it. Missing for CLI connections. */
  connectedBy?: string;
}

/** Return the plugins whose `accounts` block allows a service account. */
export function serviceAccountPlugins(
  plugins: PluginDefinition[],
): PluginDefinition[] {
  return plugins.filter((plugin) => plugin.manifest.accounts?.serviceAccount);
}

/** Read the service account status for one plugin. */
export async function getServiceAccountStatus(
  plugin: PluginDefinition,
): Promise<ServiceAccountStatus> {
  const { manifest } = plugin;
  const serviceAccount = manifest.accounts?.serviceAccount;
  if (!serviceAccount) {
    throw new Error(`Plugin ${manifest.name} does not allow a service account`);
  }
  const credentials = manifest.mcp
    ? await getMcpServiceAccountCredentials(manifest.name)
    : await getOAuthServiceAccountCredentials(manifest.name);
  return {
    provider: manifest.name,
    displayName: manifest.displayName,
    userOAuth: !serviceAccountOnly(manifest),
    tools: serviceAccount.tools ?? [],
    operations: serviceAccount.operations ?? [],
    connected: Boolean(credentials),
    ...(credentials
      ? { connectedAt: new Date(credentials.connectedAtMs).toISOString() }
      : undefined),
    ...(credentials?.connectedBy
      ? { connectedBy: credentials.connectedBy }
      : undefined),
  };
}

/**
 * Start signing in to a plugin's provider as its service account.
 *
 * Whoever signs in decides which account Junior uses, so only Junior admins
 * may start it. `startedBy` binds the sign-in to that Admin.
 */
export async function startServiceAccountSignIn(input: {
  plugin: PluginDefinition;
  redirectUrl: string;
  startedBy?: string;
}): Promise<{ authorizationUrl: URL }> {
  return input.plugin.manifest.mcp
    ? await startMcpServiceAccountSignIn(input)
    : await startOAuthServiceAccountSignIn(input);
}

/**
 * Finish a sign-in from its OAuth callback and save the service account.
 *
 * A failure message is safe to show the Admin. Unexpected provider failures
 * throw.
 */
export async function finishServiceAccountSignIn(input: {
  callback: URLSearchParams;
  connectedBy?: string;
  plugin: PluginDefinition;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!input.plugin.manifest.mcp) {
    return await finishOAuthServiceAccountSignIn(input);
  }
  const result = await finishMcpServiceAccountSignIn(input);
  return result.ok ? { ok: true } : result;
}

/**
 * Remove a plugin's service account from Junior.
 *
 * The provider grant stays until someone revokes it in the provider.
 */
export async function disconnectServiceAccount(
  plugin: PluginDefinition,
): Promise<void> {
  await (plugin.manifest.mcp
    ? deleteMcpServiceAccountCredentials(plugin.manifest.name)
    : deleteOAuthServiceAccountCredentials(plugin.manifest.name));
}
