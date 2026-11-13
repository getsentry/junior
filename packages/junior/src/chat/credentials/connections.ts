import { randomBytes } from "node:crypto";
import type { WebActor } from "@/chat/actor";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { getSqlExecutor } from "@/chat/db";
import { deleteProviderIdentityForUser } from "@/chat/identities/sql";
import {
  connectionAccount,
  type StoredTokens,
  type UserConnection,
  type UserTokenStore,
} from "@/chat/credentials/user-token-store";
import type { OAuthAuthorizationRequest } from "@/chat/oauth-authorization";
import { startOAuthFlow } from "@/chat/oauth-flow";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginDefinition } from "@/chat/plugins/types";

/**
 * Status of a plugin account for one user.
 *
 * - `needs_reauth`: the stored grant lacks the scope that the plugin requires.
 * - `expired`: the provider rejected the refresh token.
 */
export type ConnectionStatus =
  | "connected"
  | "needs_reauth"
  | "expired"
  | "disconnected";

/** One plugin account that a user can connect and disconnect. */
export interface Connection {
  provider: string;
  displayName: string;
  description: string;
  account?: { label: string; url?: string };
  /** True only when `status` is `connected`. Kept for older clients. */
  connected: boolean;
  status: ConnectionStatus;
}

function connectionStatus(
  connection: UserConnection | undefined,
  plugin: PluginDefinition,
): ConnectionStatus {
  if (!connection) return "disconnected";
  if (connection.status === "expired") return "expired";
  return hasRequiredOAuthScope(
    connection.tokens.scope,
    plugin.manifest.oauth?.scope,
  )
    ? "connected"
    : "needs_reauth";
}

/** Return stored OAuth tokens only when they still carry the manifest scope. */
export async function readConnectedOAuthTokens(
  userId: string,
  plugin: PluginDefinition,
  userTokenStore: UserTokenStore,
): Promise<StoredTokens | undefined> {
  if (!plugin.manifest.oauth && !plugin.manifest.credentials) {
    return undefined;
  }
  const stored = await userTokenStore.get(userId, plugin.manifest.name);
  return stored &&
    hasRequiredOAuthScope(stored.scope, plugin.manifest.oauth?.scope)
    ? stored
    : undefined;
}

function connectablePlugin(provider: string): PluginDefinition | undefined {
  const plugin = pluginCatalogRuntime.getDefinition(provider);
  return plugin?.manifest.oauth ? plugin : undefined;
}

/** List OAuth plugins and the user's connection state for each one. */
export async function listConnections(
  userId: string,
  userTokenStore: UserTokenStore,
): Promise<Connection[]> {
  const plugins = pluginCatalogRuntime
    .getProviders()
    .filter((plugin) => Boolean(plugin.manifest.oauth));
  return await Promise.all(
    plugins.map(async (plugin) => {
      const connection = await userTokenStore.read(
        userId,
        plugin.manifest.name,
      );
      const status = connectionStatus(connection, plugin);
      const account = connectionAccount(connection);
      return {
        provider: plugin.manifest.name,
        displayName: plugin.manifest.displayName,
        description: plugin.manifest.description,
        connected: status === "connected",
        status,
        ...(account
          ? {
              account: {
                label: account.label ?? account.id,
                ...(account.url ? { url: account.url } : undefined),
              },
            }
          : undefined),
      };
    }),
  );
}

/** True when the provider is an installed plugin with user OAuth. */
export function isConnectableProvider(provider: string): boolean {
  return Boolean(connectablePlugin(provider));
}

/**
 * Start OAuth for a dashboard viewer and return the provider authorization URL.
 * The callback stores tokens under the viewer's web actor id.
 */
export async function startConnection(
  provider: string,
  actor: WebActor,
): Promise<
  { ok: true; authorizationUrl: string } | { ok: false; error: string }
> {
  let request: OAuthAuthorizationRequest | undefined;
  const result = await startOAuthFlow(provider, {
    actorId: actor.userId,
    actor,
    authorization: {
      createState: async () => randomBytes(32).toString("hex"),
      deliver: (next) => {
        request = next;
      },
    },
  });
  if (!result.ok) return result;
  if (!request) {
    throw new Error("OAuth flow finished without an authorization request");
  }
  return { ok: true, authorizationUrl: request.authorizationUrl };
}

/**
 * Remove the viewer's stored connection for one provider and the provider
 * identity that the connection linked to the viewer's User.
 */
export async function disconnectConnection(
  userId: string,
  provider: string,
  userTokenStore: UserTokenStore,
): Promise<void> {
  const account = connectionAccount(
    await userTokenStore.read(userId, provider),
  );
  if (account) {
    await deleteProviderIdentityForUser(
      getSqlExecutor(),
      userId,
      provider,
      account.id,
    );
  }
  await unlinkProvider(userId, provider, userTokenStore);
}
