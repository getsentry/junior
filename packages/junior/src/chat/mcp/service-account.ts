/**
 * MCP service account credentials.
 *
 * This is the MCP surface of a plugin's service account. See
 * `@/chat/credentials/service-account` for the credential order and the
 * policy. An Admin connects the account from the dashboard Admin page, or
 * with `junior service-account connect <plugin>`. The credential stays on
 * the host. The sandbox and the model never get it.
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
const SIGN_IN_KEY_PREFIX = "junior:mcp_service_account_sign_in";
const SIGN_IN_TTL_MS = 10 * 60 * 1000;

/** Stored OAuth state for one plugin's service account. */
export interface McpServiceAccountCredentials {
  clientInformation: OAuthClientInformationMixed;
  connectedAtMs: number;
  /** Email of the Admin who connected the account. Missing for CLI connections. */
  connectedBy?: string;
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
      ...(typeof parsed.connectedBy === "string"
        ? { connectedBy: parsed.connectedBy }
        : undefined),
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

/** Pending MCP service account sign-in, kept until the OAuth callback. */
interface McpServiceAccountSignIn {
  clientInformation: OAuthClientInformationMixed;
  codeVerifier: string;
  discoveryState?: OAuthDiscoveryState;
  provider: string;
  redirectUrl: string;
  /** Email of the Admin who started the sign-in. Only they may finish it. */
  startedBy?: string;
}

function signInKey(state: string): string {
  return `${SIGN_IN_KEY_PREFIX}:${state}`;
}

function parseSignIn(value: unknown): McpServiceAccountSignIn | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.clientInformation) ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.redirectUrl !== "string"
    ) {
      return undefined;
    }
    return {
      clientInformation:
        parsed.clientInformation as OAuthClientInformationMixed,
      codeVerifier: parsed.codeVerifier,
      ...(isRecord(parsed.discoveryState)
        ? {
            // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
            discoveryState: parsed.discoveryState as OAuthDiscoveryState,
          }
        : undefined),
      provider: parsed.provider,
      redirectUrl: parsed.redirectUrl,
      ...(typeof parsed.startedBy === "string"
        ? { startedBy: parsed.startedBy }
        : undefined),
    };
  } catch {
    return undefined;
  }
}

/** Result of finishing a sign-in. A failure message is safe to show the Admin. */
export type McpServiceAccountSignInResult =
  | { ok: true; credentials: McpServiceAccountCredentials }
  | { ok: false; message: string };

/** Build an OAuth client provider that keeps sign-in state in memory. */
function signInProvider(input: {
  pending?: McpServiceAccountSignIn;
  redirectUrl: string;
  state?: string;
}) {
  const captured: {
    authorizationUrl?: URL;
    clientInformation?: OAuthClientInformationMixed;
    codeVerifier?: string;
    discoveryState?: OAuthDiscoveryState;
    tokens?: OAuthTokens;
  } = {
    clientInformation: input.pending?.clientInformation,
    codeVerifier: input.pending?.codeVerifier,
    discoveryState: input.pending?.discoveryState,
  };
  const provider: OAuthClientProvider = {
    redirectUrl: input.redirectUrl,
    clientMetadata: clientMetadata(input.redirectUrl),
    ...(input.state ? { state: () => input.state as string } : undefined),
    clientInformation: () => captured.clientInformation,
    saveClientInformation: (next) => {
      captured.clientInformation = next;
    },
    tokens: () => captured.tokens,
    saveTokens: (next) => {
      captured.tokens = next;
    },
    discoveryState: () => captured.discoveryState,
    saveDiscoveryState: (next) => {
      captured.discoveryState = next;
    },
    redirectToAuthorization: (url) => {
      captured.authorizationUrl = url;
    },
    saveCodeVerifier: (next) => {
      captured.codeVerifier = next;
    },
    codeVerifier: () => {
      if (!captured.codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier");
      }
      return captured.codeVerifier;
    },
  };
  return { captured, provider };
}

function requireServiceAccountMcp(plugin: PluginDefinition) {
  const mcp = plugin.manifest.mcp;
  if (!mcp || !plugin.manifest.accounts?.serviceAccount) {
    throw new Error(
      `Plugin "${plugin.manifest.name}" does not support a service account`,
    );
  }
  return mcp;
}

/**
 * Start a service account sign-in and return the provider sign-in URL.
 *
 * The pending sign-in is single use and expires after a short time. Whoever
 * signs in decides which account Junior uses, so only Junior admins may start
 * it.
 */
export async function startMcpServiceAccountSignIn(input: {
  plugin: PluginDefinition;
  redirectUrl: string;
  startedBy?: string;
}): Promise<{ authorizationUrl: URL }> {
  const mcp = requireServiceAccountMcp(input.plugin);
  const provider = input.plugin.manifest.name;
  const state = randomUUID();
  const signIn = signInProvider({ redirectUrl: input.redirectUrl, state });
  if ((await auth(signIn.provider, { serverUrl: mcp.url })) !== "REDIRECT") {
    throw new Error(`${provider} did not start an OAuth sign-in`);
  }
  const { authorizationUrl, clientInformation, codeVerifier, discoveryState } =
    signIn.captured;
  if (!authorizationUrl || !clientInformation || !codeVerifier) {
    throw new Error(`${provider} did not return an authorization URL`);
  }
  await getStateAdapter().set(
    signInKey(state),
    JSON.stringify({
      clientInformation,
      codeVerifier,
      ...(discoveryState ? { discoveryState } : undefined),
      provider,
      redirectUrl: input.redirectUrl,
      ...(input.startedBy ? { startedBy: input.startedBy } : undefined),
    } satisfies McpServiceAccountSignIn),
    SIGN_IN_TTL_MS,
  );
  return { authorizationUrl };
}

/**
 * Finish a service account sign-in from the OAuth callback parameters.
 *
 * It accepts only a pending sign-in for the same plugin that the same Admin
 * started. It then saves the grant as the plugin's service account.
 */
export async function finishMcpServiceAccountSignIn(input: {
  callback: URLSearchParams;
  connectedBy?: string;
  plugin: PluginDefinition;
}): Promise<McpServiceAccountSignInResult> {
  const mcp = requireServiceAccountMcp(input.plugin);
  const provider = input.plugin.manifest.name;
  const state = input.callback.get("state");
  const pending = state
    ? parseSignIn(await getStateAdapter().get(signInKey(state)))
    : undefined;
  if (
    !state ||
    !pending ||
    pending.provider !== provider ||
    pending.startedBy !== input.connectedBy
  ) {
    return {
      ok: false,
      message: "This sign-in expired or did not start here. Start it again.",
    };
  }
  await getStateAdapter().delete(signInKey(state));
  const error = input.callback.get("error");
  if (error) {
    return {
      ok: false,
      message: `${provider} did not finish the sign-in (${error}).`,
    };
  }
  const authorizationCode = input.callback.get("code");
  if (!authorizationCode) {
    return {
      ok: false,
      message: `${provider} did not return an authorization code.`,
    };
  }
  const signIn = signInProvider({ pending, redirectUrl: pending.redirectUrl });
  await auth(signIn.provider, { serverUrl: mcp.url, authorizationCode });
  const { clientInformation, discoveryState, tokens } = signIn.captured;
  if (!clientInformation || !tokens) {
    throw new Error(`${provider} did not issue tokens`);
  }

  const credentials: McpServiceAccountCredentials = {
    clientInformation,
    connectedAtMs: Date.now(),
    ...(input.connectedBy ? { connectedBy: input.connectedBy } : undefined),
    ...(discoveryState ? { discoveryState } : undefined),
    redirectUrl: pending.redirectUrl,
    tokens,
  };
  await putMcpServiceAccountCredentials(provider, credentials);
  return { ok: true, credentials };
}
