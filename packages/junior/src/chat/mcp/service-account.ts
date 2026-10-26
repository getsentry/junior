/**
 * MCP service accounts.
 *
 * A plugin can declare `mcp.serviceAccount`. An admin then connects one
 * provider account that Junior itself uses, with
 * `junior service-account connect <plugin>`. An actor who has not connected
 * their own account uses this account for the declared read tools. The
 * credential stays on the host. The sandbox and the model never get it.
 */
import { randomUUID } from "node:crypto";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { isRecord } from "@/chat/coerce";
import { logWarn } from "@/chat/logging";
import type { PluginDefinition } from "@/chat/plugins/types";
import { getStateAdapter } from "@/chat/state/adapter";

const SERVICE_ACCOUNT_KEY_PREFIX = "junior:mcp_service_account";

/** Stored OAuth state for one plugin's service account. */
export interface McpServiceAccountCredentials {
  clientInformation: OAuthClientInformationMixed;
  connectedAtMs: number;
  discoveryState?: OAuthDiscoveryState;
  /** Redirect URI registered for the client. The SDK refreshes tokens only for clients with one. */
  redirectUrl: string;
  tokens: OAuthTokens;
}

function serviceAccountKey(provider: string): string {
  return `${SERVICE_ACCOUNT_KEY_PREFIX}:${provider}`;
}

function parseCredentials(
  value: unknown,
): McpServiceAccountCredentials | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.clientInformation) ||
      !isRecord(parsed.tokens) ||
      typeof parsed.connectedAtMs !== "number" ||
      typeof parsed.redirectUrl !== "string"
    ) {
      return undefined;
    }
    return {
      clientInformation:
        parsed.clientInformation as OAuthClientInformationMixed,
      connectedAtMs: parsed.connectedAtMs,
      ...(isRecord(parsed.discoveryState)
        ? {
            // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
            discoveryState: parsed.discoveryState as OAuthDiscoveryState,
          }
        : undefined),
      redirectUrl: parsed.redirectUrl,
      tokens: parsed.tokens as OAuthTokens,
    };
  } catch {
    return undefined;
  }
}

/** Read the connected service account for one plugin, if any. */
export async function getMcpServiceAccountCredentials(
  provider: string,
): Promise<McpServiceAccountCredentials | undefined> {
  return parseCredentials(
    await getStateAdapter().get(serviceAccountKey(provider)),
  );
}

/** Save the service account for one plugin. It does not expire. */
export async function putMcpServiceAccountCredentials(
  provider: string,
  credentials: McpServiceAccountCredentials,
): Promise<void> {
  await getStateAdapter().set(
    serviceAccountKey(provider),
    JSON.stringify(credentials),
  );
}

/** Remove the service account for one plugin. The provider grant stays until the provider revokes it. */
export async function deleteMcpServiceAccountCredentials(
  provider: string,
): Promise<void> {
  await getStateAdapter().delete(serviceAccountKey(provider));
}

function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: "Junior MCP Service Account",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

function reconnectMessage(provider: string): string {
  return `The ${provider} service account is not authorized anymore. A Junior admin must run \`junior service-account connect ${provider}\`.`;
}

/**
 * Build the OAuth client provider for a connected service account.
 *
 * It refreshes tokens like a user connection but never starts a new sign-in.
 * Many turns share this account, so it reads the store on each request and
 * deletes the stored grant only when the rejected refresh token is still the
 * stored one. A turn that lost a refresh race thus does not disconnect the
 * account for everyone.
 */
export function createMcpServiceAccountClientProvider(
  provider: string,
  connected: McpServiceAccountCredentials,
): OAuthClientProvider {
  let lastRefreshToken = connected.tokens.refresh_token;
  let tokensRejected = false;

  const update = async (
    patch: Partial<McpServiceAccountCredentials>,
  ): Promise<void> => {
    const current = await getMcpServiceAccountCredentials(provider);
    if (!current) {
      throw new Error(reconnectMessage(provider));
    }
    await putMcpServiceAccountCredentials(provider, { ...current, ...patch });
  };

  return {
    redirectUrl: connected.redirectUrl,
    clientMetadata: clientMetadata(connected.redirectUrl),
    clientInformation: async () =>
      (await getMcpServiceAccountCredentials(provider))?.clientInformation,
    saveClientInformation: async (clientInformation) => {
      await update({ clientInformation });
    },
    tokens: async () => {
      if (tokensRejected) {
        return undefined;
      }
      const tokens = (await getMcpServiceAccountCredentials(provider))?.tokens;
      lastRefreshToken = tokens?.refresh_token;
      return tokens;
    },
    saveTokens: async (tokens) => {
      tokensRejected = false;
      lastRefreshToken = tokens.refresh_token;
      await update({ tokens });
    },
    discoveryState: async () =>
      (await getMcpServiceAccountCredentials(provider))?.discoveryState,
    saveDiscoveryState: async (discoveryState) => {
      await update({ discoveryState });
    },
    invalidateCredentials: (scope) => {
      // The SDK retries without tokens after a rejected refresh. Keep the
      // stored grant until that retry proves it cannot recover.
      if (scope === "all" || scope === "tokens") {
        tokensRejected = true;
      }
    },
    redirectToAuthorization: async () => {
      const stored = await getMcpServiceAccountCredentials(provider);
      if (stored && stored.tokens.refresh_token === lastRefreshToken) {
        await deleteMcpServiceAccountCredentials(provider);
        logWarn("mcp.service_account.disconnected", {
          "app.plugin.name": provider,
        });
      }
      throw new Error(reconnectMessage(provider));
    },
    // The SDK saves a verifier just before it asks for a new sign-in, which
    // `redirectToAuthorization` then refuses.
    saveCodeVerifier: () => undefined,
    codeVerifier: () => {
      throw new Error(reconnectMessage(provider));
    },
  };
}

/**
 * Sign in to a plugin's MCP server as its service account and save the grant.
 *
 * The caller owns the browser step and the redirect listener. Whoever signs
 * in decides which account Junior uses, so only Junior admins may run this.
 */
export async function connectMcpServiceAccount(input: {
  /** Show the sign-in URL and wait for the redirect query parameters. */
  authorize: (authorizationUrl: URL) => Promise<URLSearchParams>;
  plugin: PluginDefinition;
  redirectUrl: string;
}): Promise<McpServiceAccountCredentials> {
  const mcp = input.plugin.manifest.mcp;
  const provider = input.plugin.manifest.name;
  if (!mcp?.serviceAccount) {
    throw new Error(`Plugin "${provider}" does not support a service account`);
  }

  const state = randomUUID();
  let authorizationUrl: URL | undefined;
  let clientInformation: OAuthClientInformationMixed | undefined;
  let codeVerifier: string | undefined;
  let discoveryState: OAuthDiscoveryState | undefined;
  let tokens: OAuthTokens | undefined;
  const signIn: OAuthClientProvider = {
    redirectUrl: input.redirectUrl,
    clientMetadata: clientMetadata(input.redirectUrl),
    state: () => state,
    clientInformation: () => clientInformation,
    saveClientInformation: (next) => {
      clientInformation = next;
    },
    tokens: () => tokens,
    saveTokens: (next) => {
      tokens = next;
    },
    discoveryState: () => discoveryState,
    saveDiscoveryState: (next) => {
      discoveryState = next;
    },
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
    saveCodeVerifier: (next) => {
      codeVerifier = next;
    },
    codeVerifier: () => {
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier");
      }
      return codeVerifier;
    },
  };

  if ((await auth(signIn, { serverUrl: mcp.url })) !== "REDIRECT") {
    throw new Error(`${provider} did not start an OAuth sign-in`);
  }
  if (!authorizationUrl) {
    throw new Error(`${provider} did not return an authorization URL`);
  }
  const callback = await input.authorize(authorizationUrl);
  if (callback.get("state") !== state) {
    throw new Error("OAuth callback state does not match this sign-in");
  }
  const error = callback.get("error");
  if (error) {
    throw new Error(`${provider} rejected the sign-in: ${error}`);
  }
  const authorizationCode = callback.get("code");
  if (!authorizationCode) {
    throw new Error("OAuth callback has no authorization code");
  }
  await auth(signIn, { serverUrl: mcp.url, authorizationCode });
  if (!clientInformation || !tokens) {
    throw new Error(`${provider} did not issue tokens`);
  }

  const credentials: McpServiceAccountCredentials = {
    clientInformation,
    connectedAtMs: Date.now(),
    ...(discoveryState ? { discoveryState } : undefined),
    redirectUrl: input.redirectUrl,
    tokens,
  };
  await putMcpServiceAccountCredentials(provider, credentials);
  return credentials;
}
