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
import { McpAuthorizationRequiredError } from "@/chat/mcp/client";
import type { PluginDefinition } from "@/chat/plugins/types";
import {
  createEncryptedState,
  readEncryptedState,
} from "@/chat/encryption/state";
import { getStateAdapter } from "@/chat/state/adapter";
import { fenceLock, MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";

const SERVICE_ACCOUNT_KEY_PREFIX = "junior:mcp_service_account";
const SIGN_IN_KEY_PREFIX = "junior:mcp_service_account_sign_in";
const SIGN_IN_TTL_MS = 10 * 60 * 1000;
const UPDATE_LOCK_WAIT_MS = 5_000;

/** OAuth grant of one connected service account. */
export interface McpServiceAccountCredentials {
  clientInformation: OAuthClientInformationMixed;
  connectedAtMs: number;
  /** Email of the Admin who connected the account. Missing for CLI connections. */
  connectedBy?: string;
  /** Identifies this connection. Each sign-in starts a new one. */
  connectionId: string;
  discoveryState?: OAuthDiscoveryState;
  /** Redirect URI registered for the client. The SDK refreshes tokens only for clients with one. */
  redirectUrl: string;
  tokens: OAuthTokens;
}

/**
 * Stored lifecycle of one plugin's service account.
 *
 * No record means that no Admin connected the account or that an Admin
 * disconnected it. `revoked` means the provider rejected the grant. It stays
 * until an Admin connects the account again or disconnects it.
 */
export type McpServiceAccount =
  | ({ status: "connected" } & McpServiceAccountCredentials)
  | { status: "revoked"; revokedAtMs: number };

/** One change to a plugin's service account. */
export type McpServiceAccountChange =
  /** An Admin finished a sign-in. It replaces any earlier connection. */
  | { type: "connect"; credentials: McpServiceAccountCredentials }
  /** A turn saved new OAuth state for the connection that it uses. */
  | {
      type: "update";
      connectionId: string;
      patch: Partial<
        Pick<
          McpServiceAccountCredentials,
          "clientInformation" | "discoveryState" | "tokens"
        >
      >;
    }
  /** The provider rejected this refresh token of the connection. */
  | { type: "revoke"; connectionId: string; refreshToken?: string }
  /** An Admin removed the account from Junior. */
  | { type: "disconnect" };

function serviceAccountKey(provider: string): string {
  return `${SERVICE_ACCOUNT_KEY_PREFIX}:${provider}`;
}

function updateLockKey(provider: string): string {
  return `${serviceAccountKey(provider)}:update`;
}

function parseAccount(value: unknown): McpServiceAccount | undefined {
  let parsed: unknown;
  try {
    // Plaintext values from before encryption are JSON strings.
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (parsed.status === "revoked") {
    return typeof parsed.revokedAtMs === "number"
      ? { status: "revoked", revokedAtMs: parsed.revokedAtMs }
      : undefined;
  }
  // Records saved before `status` existed are connected grants.
  if (
    (parsed.status !== undefined && parsed.status !== "connected") ||
    !isRecord(parsed.clientInformation) ||
    !isRecord(parsed.tokens) ||
    typeof parsed.connectedAtMs !== "number" ||
    typeof parsed.redirectUrl !== "string"
  ) {
    return undefined;
  }
  return {
    status: "connected",
    clientInformation: parsed.clientInformation as OAuthClientInformationMixed,
    connectedAtMs: parsed.connectedAtMs,
    ...(typeof parsed.connectedBy === "string"
      ? { connectedBy: parsed.connectedBy }
      : undefined),
    // Records saved before connection ids existed have one connection each.
    connectionId:
      typeof parsed.connectionId === "string"
        ? parsed.connectionId
        : `legacy-${parsed.connectedAtMs}`,
    ...(isRecord(parsed.discoveryState)
      ? {
          // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
          discoveryState: parsed.discoveryState as OAuthDiscoveryState,
        }
      : undefined),
    redirectUrl: parsed.redirectUrl,
    tokens: parsed.tokens as OAuthTokens,
  };
}

function isConnection(
  account: McpServiceAccount | undefined,
  connectionId: string,
): account is Extract<McpServiceAccount, { status: "connected" }> {
  return (
    account?.status === "connected" && account.connectionId === connectionId
  );
}

/** Read the stored service account for one plugin, if any. */
export async function getMcpServiceAccount(
  provider: string,
): Promise<McpServiceAccount | undefined> {
  const stored = await readEncryptedState(
    getStateAdapter(),
    serviceAccountKey(provider),
  );
  const account = parseAccount(stored?.value);
  if (account && stored?.stale) {
    await saveStaleAccount(provider);
  }
  return account;
}

/**
 * Save a stale account again with the active key. It keeps the stored value
 * and runs only when the update lock is free, so it cannot write back a
 * value that a transition replaced.
 */
async function saveStaleAccount(provider: string): Promise<void> {
  const state = getStateAdapter();
  await withLock(
    state,
    updateLockKey(provider),
    async (lock) => {
      const key = serviceAccountKey(provider);
      const current = await readEncryptedState(state, key);
      const account = parseAccount(current?.value);
      if (!current?.stale || !account) return;
      await fenceLock(state, lock);
      await createEncryptedState(state).set(key, account);
    },
    { ttlMs: MUTATION_LOCK_TTL_MS },
  );
}

function nextAccount(
  current: McpServiceAccount | undefined,
  change: McpServiceAccountChange,
): McpServiceAccount | undefined {
  switch (change.type) {
    case "connect":
      return { status: "connected", ...change.credentials };
    case "disconnect":
      return undefined;
    case "update":
      // A turn that used a connection that is gone must not bring it back
      // or write its tokens into a newer connection.
      return isConnection(current, change.connectionId)
        ? { ...current, ...change.patch }
        : current;
    case "revoke":
      // Another turn may already have replaced the rejected token.
      return isConnection(current, change.connectionId) &&
        current.tokens.refresh_token === change.refreshToken
        ? { status: "revoked", revokedAtMs: Date.now() }
        : current;
  }
}

/**
 * Apply one change to a plugin's service account and return the stored result.
 *
 * This is the only writer that changes the account. It reads and writes under one
 * lock, so a racing refresh cannot undo a Disconnect, a revocation, or a new
 * sign-in. It ignores an update or a revocation for a connection that is no
 * longer stored.
 */
export async function transitionMcpServiceAccount(
  provider: string,
  change: McpServiceAccountChange,
): Promise<McpServiceAccount | undefined> {
  const state = getStateAdapter();
  const key = serviceAccountKey(provider);
  const result = await withLock(
    state,
    updateLockKey(provider),
    async (lock) => {
      const current = parseAccount(
        (await readEncryptedState(state, key))?.value,
      );
      const next = nextAccount(current, change);
      if (next === current) {
        return current;
      }
      await fenceLock(state, lock);
      if (next) {
        await createEncryptedState(state).set(key, next);
      } else {
        await state.delete(key);
      }
      if (next?.status === "revoked") {
        logWarn("mcp.service_account.revoked", {
          "app.plugin.name": provider,
        });
      }
      return next;
    },
    { ttlMs: MUTATION_LOCK_TTL_MS, waitMs: UPDATE_LOCK_WAIT_MS },
  );
  if (!result.acquired) {
    throw new Error(
      `Timed out waiting to update the ${provider} service account`,
    );
  }
  return result.value;
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
  return `The ${provider} service account is not authorized anymore. An admin must run \`junior service-account connect ${provider}\`.`;
}

/**
 * Build the OAuth client provider for one connection of a service account.
 *
 * It refreshes tokens like a user connection but never starts a new sign-in.
 * Many turns share this account, so it reads the store on each request and
 * writes each change through `transitionMcpServiceAccount`. It uses only the
 * connection that it started with: after a Disconnect, a revocation, or a new
 * sign-in, it has no credentials. When the provider rejects a refresh token
 * that another turn already replaced, it retries with the stored one. It
 * marks the connection revoked only when the provider rejected the stored
 * token itself, and then throws `McpAuthorizationRequiredError` so the tool
 * manager can fall back to Actor auth or report the missing account. A
 * refresh that fails for another reason, such as a network error, keeps the
 * account.
 */
export function createMcpServiceAccountClientProvider(
  provider: string,
  connected: McpServiceAccountCredentials,
): OAuthClientProvider {
  const { connectionId } = connected;
  let lastRefreshToken = connected.tokens.refresh_token;
  let tokensRejected = false;

  const read = async () => {
    const account = await getMcpServiceAccount(provider);
    return isConnection(account, connectionId) ? account : undefined;
  };

  const update = async (
    patch: Extract<McpServiceAccountChange, { type: "update" }>["patch"],
  ): Promise<void> => {
    const account = await transitionMcpServiceAccount(provider, {
      type: "update",
      connectionId,
      patch,
    });
    if (!isConnection(account, connectionId)) {
      throw new Error(
        `The ${provider} service account changed during this request. Try again.`,
      );
    }
  };

  return {
    redirectUrl: connected.redirectUrl,
    clientMetadata: clientMetadata(connected.redirectUrl),
    clientInformation: async () => (await read())?.clientInformation,
    saveClientInformation: async (clientInformation) => {
      await update({ clientInformation });
    },
    tokens: async () => {
      const tokens = (await read())?.tokens;
      if (tokensRejected) {
        // Another turn replaced the rejected token. Retry with the new one.
        if (!tokens || tokens.refresh_token === lastRefreshToken) {
          return undefined;
        }
        tokensRejected = false;
      }
      lastRefreshToken = tokens?.refresh_token;
      return tokens;
    },
    saveTokens: async (tokens) => {
      tokensRejected = false;
      lastRefreshToken = tokens.refresh_token;
      await update({ tokens });
    },
    discoveryState: async () => (await read())?.discoveryState,
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
      // Without a rejection, the refresh failed for a reason that can pass,
      // such as a network error, so only read the account.
      const account =
        tokensRejected || !lastRefreshToken
          ? await transitionMcpServiceAccount(provider, {
              type: "revoke",
              connectionId,
              refreshToken: lastRefreshToken,
            })
          : await getMcpServiceAccount(provider);
      // A connected account here has a newer token or a new sign-in.
      if (account?.status === "connected") {
        throw new Error(
          `The ${provider} service account could not refresh its token. Try again later.`,
        );
      }
      throw new McpAuthorizationRequiredError(
        provider,
        reconnectMessage(provider),
      );
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
  if (
    !isRecord(value) ||
    !isRecord(value.clientInformation) ||
    typeof value.codeVerifier !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.redirectUrl !== "string"
  ) {
    return undefined;
  }
  return {
    clientInformation: value.clientInformation as OAuthClientInformationMixed,
    codeVerifier: value.codeVerifier,
    ...(isRecord(value.discoveryState)
      ? {
          // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
          discoveryState: value.discoveryState as OAuthDiscoveryState,
        }
      : undefined),
    provider: value.provider,
    redirectUrl: value.redirectUrl,
    ...(typeof value.startedBy === "string"
      ? { startedBy: value.startedBy }
      : undefined),
  };
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
  await createEncryptedState(getStateAdapter()).set(
    signInKey(state),
    {
      clientInformation,
      codeVerifier,
      ...(discoveryState ? { discoveryState } : undefined),
      provider,
      redirectUrl: input.redirectUrl,
      ...(input.startedBy ? { startedBy: input.startedBy } : undefined),
    } satisfies McpServiceAccountSignIn,
    SIGN_IN_TTL_MS,
  );
  return { authorizationUrl };
}

const expiredSignIn = {
  ok: false,
  message: "This sign-in expired or did not start here. Start it again.",
} as const;

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
    ? parseSignIn(
        await createEncryptedState(getStateAdapter()).get(signInKey(state)),
      )
    : undefined;
  if (
    !state ||
    !pending ||
    pending.provider !== provider ||
    pending.startedBy !== input.connectedBy
  ) {
    return expiredSignIn;
  }
  // Claim the sign-in atomically, so a repeated callback cannot finish it
  // twice.
  if (
    !(await getStateAdapter().setIfNotExists(
      `${signInKey(state)}:finished`,
      true,
      SIGN_IN_TTL_MS,
    ))
  ) {
    return expiredSignIn;
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
    connectionId: randomUUID(),
    ...(discoveryState ? { discoveryState } : undefined),
    redirectUrl: pending.redirectUrl,
    tokens,
  };
  await transitionMcpServiceAccount(provider, {
    type: "connect",
    credentials,
  });
  return { ok: true, credentials };
}
