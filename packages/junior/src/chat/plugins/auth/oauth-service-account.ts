/**
 * OAuth service account credentials.
 *
 * This is the top-level `oauth` surface of a plugin's service account. See
 * `@/chat/credentials/service-account` for the credential order and the
 * policy. An Admin signs in once as the shared provider account. The
 * oauth-bearer broker then reads the stored token for host egress requests
 * that name an operation the account lists. The credential stays on the
 * host. The sandbox and the model never get it.
 */
import { randomBytes } from "node:crypto";
import * as z from "zod";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import {
  createEncryptedState,
  readEncryptedState,
} from "@/chat/encryption/state";
import { getStateAdapter } from "@/chat/state/adapter";
import { fenceLock, MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";
import type { PluginDefinition, PluginOAuthConfig } from "../types";
import {
  buildOAuthTokenRequest,
  parseOAuthAccessTokenResponse,
} from "./oauth-request";

const SERVICE_ACCOUNT_KEY_PREFIX = "junior:oauth_service_account";
const SIGN_IN_KEY_PREFIX = "junior:oauth_service_account_sign_in";
const SIGN_IN_TTL_MS = 10 * 60 * 1000;
// A token refresh can take up to 20 seconds, so the lock that covers it must
// outlive the refresh, and a caller that waits must outwait it.
const REFRESH_LOCK_TTL_MS = 30_000;
const REFRESH_LOCK_WAIT_MS = 30_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 20_000;

/** Stored tokens for one plugin's OAuth service account. */
export interface OAuthServiceAccountCredentials {
  accessToken: string;
  connectedAtMs: number;
  /** Email of the Admin who connected the account. Missing for CLI connections. */
  connectedBy?: string;
  /** Missing when the provider issued a token that does not expire. */
  expiresAt?: number;
  /** Missing when the provider issued no refresh token. */
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  scope?: string;
}

const credentialsSchema = z.object({
  accessToken: z.string().min(1),
  connectedAtMs: z.number(),
  connectedBy: z.string().optional().catch(undefined),
  expiresAt: z.number().optional(),
  refreshToken: z.string().min(1).optional(),
  refreshTokenExpiresAt: z.number().optional(),
  scope: z.string().optional(),
});

function serviceAccountKey(provider: string): string {
  return `${SERVICE_ACCOUNT_KEY_PREFIX}:${provider}`;
}

function parseCredentials(
  value: unknown,
): OAuthServiceAccountCredentials | undefined {
  const parsed = credentialsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Read the connected OAuth service account for one plugin, if any. */
export async function getOAuthServiceAccountCredentials(
  provider: string,
): Promise<OAuthServiceAccountCredentials | undefined> {
  const state = getStateAdapter();
  const stored = await readEncryptedState(state, serviceAccountKey(provider));
  const credentials = parseCredentials(stored?.value);
  if (credentials && stored?.stale) {
    // Save it again with the active key, unless a refresh holds the lock.
    await withLock(
      state,
      updateLockKey(provider),
      async (lock) => {
        const current = await readEncryptedState(
          state,
          serviceAccountKey(provider),
        );
        const latest = parseCredentials(current?.value);
        if (!current?.stale || !latest) return;
        await fenceLock(state, lock);
        await putOAuthServiceAccountCredentials(provider, latest);
      },
      { ttlMs: MUTATION_LOCK_TTL_MS },
    );
  }
  return credentials;
}

/** Save the OAuth service account for one plugin. */
export async function putOAuthServiceAccountCredentials(
  provider: string,
  credentials: OAuthServiceAccountCredentials,
): Promise<void> {
  await createEncryptedState(getStateAdapter()).set(
    serviceAccountKey(provider),
    credentials,
  );
}

/** Remove the OAuth service account. The provider grant stays until someone revokes it. */
export async function deleteOAuthServiceAccountCredentials(
  provider: string,
): Promise<void> {
  await getStateAdapter().delete(serviceAccountKey(provider));
}

function updateLockKey(provider: string): string {
  return `${serviceAccountKey(provider)}:update`;
}

/**
 * Run a read and write of the stored account under one lock, so a turn
 * cannot write back or delete a refresh token that another turn replaced.
 */
export async function withOAuthServiceAccountLock<T>(
  provider: string,
  run: (fence: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const state = getStateAdapter();
  const result = await withLock(
    state,
    updateLockKey(provider),
    async (lock) => await run(() => fenceLock(state, lock)),
    { ttlMs: REFRESH_LOCK_TTL_MS, waitMs: REFRESH_LOCK_WAIT_MS },
  );
  if (!result.acquired) {
    throw new Error(
      `Timed out waiting to update the ${provider} service account`,
    );
  }
  return result.value;
}

/** Pending OAuth service account sign-in, kept until the callback. */
const signInSchema = z.object({
  provider: z.string(),
  redirectUrl: z.string(),
  /** Email of the Admin who started the sign-in. Only they may finish it. */
  startedBy: z.string().optional().catch(undefined),
});

function signInKey(state: string): string {
  return `${SIGN_IN_KEY_PREFIX}:${state}`;
}

function requireServiceAccountOAuth(
  plugin: PluginDefinition,
): PluginOAuthConfig {
  const { oauth, accounts, name } = plugin.manifest;
  if (!oauth || !accounts?.serviceAccount?.operations) {
    throw new Error(
      `Plugin "${name}" does not support an OAuth service account`,
    );
  }
  return oauth;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

/**
 * Start an OAuth service account sign-in and return the provider sign-in URL.
 *
 * The pending sign-in is single use and expires after a short time.
 */
export async function startOAuthServiceAccountSignIn(input: {
  plugin: PluginDefinition;
  redirectUrl: string;
  startedBy?: string;
}): Promise<{ authorizationUrl: URL }> {
  const oauth = requireServiceAccountOAuth(input.plugin);
  const clientId = requireEnv(oauth.clientIdEnv);
  const state = randomBytes(32).toString("hex");
  await createEncryptedState(getStateAdapter()).set(
    signInKey(state),
    {
      provider: input.plugin.manifest.name,
      redirectUrl: input.redirectUrl,
      ...(input.startedBy ? { startedBy: input.startedBy } : undefined),
    } satisfies z.input<typeof signInSchema>,
    SIGN_IN_TTL_MS,
  );
  const authorizationUrl = new URL(oauth.authorizeEndpoint);
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("redirect_uri", input.redirectUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  if (oauth.scope) {
    authorizationUrl.searchParams.set("scope", oauth.scope);
  }
  for (const [key, value] of Object.entries(oauth.authorizeParams ?? {})) {
    authorizationUrl.searchParams.set(key, value);
  }
  return { authorizationUrl };
}

/**
 * Finish an OAuth service account sign-in from the callback parameters.
 *
 * It accepts only a pending sign-in for the same plugin that the same Admin
 * started, exchanges the code, and saves the tokens. A failure message is
 * safe to show the Admin. Network failures throw.
 */
export async function finishOAuthServiceAccountSignIn(input: {
  callback: URLSearchParams;
  connectedBy?: string;
  plugin: PluginDefinition;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const oauth = requireServiceAccountOAuth(input.plugin);
  const provider = input.plugin.manifest.name;
  const state = input.callback.get("state");
  const parsedPending = state
    ? signInSchema.safeParse(
        await createEncryptedState(getStateAdapter()).get(signInKey(state)),
      )
    : undefined;
  const pending = parsedPending?.success ? parsedPending.data : undefined;
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
  const code = input.callback.get("code");
  if (!code) {
    return {
      ok: false,
      message: `${provider} did not return an authorization code.`,
    };
  }

  const request = buildOAuthTokenRequest({
    clientId: requireEnv(oauth.clientIdEnv),
    clientSecret: requireEnv(oauth.clientSecretEnv),
    payload: {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUrl,
    },
    tokenAuthMethod: oauth.tokenAuthMethod,
    tokenExtraHeaders: oauth.tokenExtraHeaders,
  });
  const response = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    return {
      ok: false,
      message: `${provider} did not issue tokens (HTTP ${response.status}). Start the sign-in again.`,
    };
  }
  const tokens = parseOAuthAccessTokenResponse(
    await response.json(),
    oauth.scope,
    { treatEmptyScopeAsUnreported: oauth.treatEmptyScopeAsUnreported },
  );
  if (!hasRequiredOAuthScope(tokens.scope, oauth.scope)) {
    return {
      ok: false,
      message: `${provider} did not grant the required access (${oauth.scope}).`,
    };
  }
  await putOAuthServiceAccountCredentials(provider, {
    ...tokens,
    connectedAtMs: Date.now(),
    ...(input.connectedBy ? { connectedBy: input.connectedBy } : undefined),
  });
  return { ok: true };
}
