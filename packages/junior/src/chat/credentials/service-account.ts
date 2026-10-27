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
 * account. Today MCP tools are the only request kind.
 *
 * This module also owns the connect flow that the dashboard Admin page and
 * the `junior service-account` CLI share. Today MCP is the only surface that
 * stores a service account.
 */
import {
  deleteMcpServiceAccountCredentials,
  finishMcpServiceAccountSignIn,
  getMcpServiceAccountCredentials,
  startMcpServiceAccountSignIn,
} from "@/chat/mcp/service-account";
import type { PluginDefinition, PluginManifest } from "@/chat/plugins/types";

/** One request that a plugin's service account could serve. */
export interface ServiceAccountRequest {
  /** Provider MCP tool that the request calls. */
  tool: string;
}

/** Return whether the plugin's service account may serve this request. */
export function serviceAccountAllows(
  manifest: Pick<PluginManifest, "accounts">,
  request: ServiceAccountRequest,
): boolean {
  return (
    manifest.accounts?.serviceAccount?.tools.includes(request.tool) ?? false
  );
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
  const credentials = await getMcpServiceAccountCredentials(manifest.name);
  return {
    provider: manifest.name,
    displayName: manifest.displayName,
    userOAuth: !serviceAccountOnly(manifest),
    tools: serviceAccount.tools,
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
  return await startMcpServiceAccountSignIn(input);
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
  await deleteMcpServiceAccountCredentials(plugin.manifest.name);
}
