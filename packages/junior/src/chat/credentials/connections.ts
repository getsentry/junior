import { randomBytes } from "node:crypto";
import type { WebActor } from "@/chat/actor";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { getSqlExecutor } from "@/chat/db";
import { deleteProviderIdentityForUser } from "@/chat/identities/sql";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
import type { OAuthAuthorizationRequest } from "@/chat/oauth-authorization";
import { startOAuthFlow } from "@/chat/oauth-flow";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginDefinition } from "@/chat/plugins/types";

/** One plugin account that a user can connect and disconnect. */
export interface Connection {
  provider: string;
  displayName: string;
  description: string;
  account?: { label: string; url?: string };
  connected: boolean;
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
      const tokens = await readConnectedOAuthTokens(
        userId,
        plugin,
        userTokenStore,
      );
      const account = tokens?.account;
      return {
        provider: plugin.manifest.name,
        displayName: plugin.manifest.displayName,
        description: plugin.manifest.description,
        connected: Boolean(tokens),
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
 * Remove the user's stored connection for one provider and the provider
 * identity that the connection linked to the viewer's user.
 */
export async function disconnectConnection(
  userId: string,
  provider: string,
  userTokenStore: UserTokenStore,
  viewerUserId: string,
): Promise<void> {
  const tokens = await userTokenStore.get(userId, provider);
  if (tokens?.account) {
    await deleteProviderIdentityForUser(
      getSqlExecutor(),
      viewerUserId,
      provider,
      tokens.account.id,
    );
  }
  await unlinkProvider(userId, provider, userTokenStore);
}
