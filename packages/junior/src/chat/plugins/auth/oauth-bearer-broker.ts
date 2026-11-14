import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { credentialUserSubjectId } from "@/chat/credentials/context";
import { mergeHeaderTransforms } from "@/chat/credentials/header-transforms";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import {
  OAuthProviderError,
  readBoundedOAuthErrorBody,
} from "@/chat/oauth-response";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { resolveAuthTokenPlaceholder } from "./auth-token-placeholder";
import { resolveApiHeaderTransforms } from "./api-headers-broker";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "./oauth-request";
import type { OAuthBearerCredentials, PluginManifest } from "../types";

const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_TIMEOUT_MS = 20_000;

class OAuthRefreshRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthRefreshRejectedError";
  }
}

function parseRefreshError(text: string): string | undefined {
  if (!text.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : undefined;
  } catch {
    return undefined;
  }
}

async function refreshAccessToken(
  provider: string,
  refreshToken: string,
  oauth: NonNullable<PluginManifest["oauth"]>,
  requestedScope?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scope?: string;
}> {
  const clientId = process.env[oauth.clientIdEnv]?.trim();
  const clientSecret = process.env[oauth.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing ${oauth.clientIdEnv} or ${oauth.clientSecretEnv} for token refresh`,
    );
  }

  const request = buildOAuthTokenRequest({
    clientId,
    clientSecret,
    payload: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    tokenAuthMethod: oauth.tokenAuthMethod,
    tokenExtraHeaders: oauth.tokenExtraHeaders,
  });
  const errorDetails = {
    phase: "token_refresh" as const,
    provider,
    resourceHost: new URL(oauth.tokenEndpoint).hostname,
  };
  let response: Response;
  try {
    response = await fetch(oauth.tokenEndpoint, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthProviderError(errorDetails);
  }

  if (!response.ok) {
    let errorCode: string | undefined;
    try {
      errorCode = parseRefreshError(await readBoundedOAuthErrorBody(response));
    } catch {
      throw new OAuthProviderError({
        ...errorDetails,
        status: response.status,
      });
    }
    if (errorCode === "invalid_grant" || errorCode === "bad_refresh_token") {
      throw new OAuthRefreshRejectedError("Token refresh was rejected");
    }
    throw new OAuthProviderError({
      ...errorDetails,
      status: response.status,
    });
  }

  try {
    const data = (await response.json()) as Record<string, unknown>;
    return parseOAuthTokenResponse(data, requestedScope, {
      treatEmptyScopeAsUnreported: oauth.treatEmptyScopeAsUnreported,
      refreshToken,
    });
  } catch {
    throw new OAuthProviderError(errorDetails);
  }
}

function getLeaseExpiry(expiresAt?: number): number {
  return expiresAt
    ? Math.min(expiresAt, Date.now() + MAX_LEASE_MS)
    : Date.now() + MAX_LEASE_MS;
}

function canUseStoredToken(
  stored: StoredTokens | undefined,
): stored is StoredTokens {
  return (
    stored !== undefined &&
    (stored.expiresAt === undefined || stored.expiresAt > Date.now())
  );
}

function shouldRefreshStoredToken(stored: StoredTokens | undefined): boolean {
  return (
    stored !== undefined &&
    stored.expiresAt !== undefined &&
    stored.expiresAt - Date.now() < REFRESH_BUFFER_MS
  );
}

export function createOAuthBearerBroker(
  manifest: PluginManifest,
  credentials: OAuthBearerCredentials,
  deps: { userTokenStore: UserTokenStore },
): CredentialBroker {
  const provider = manifest.name;
  const { domains, apiHeaders, authTokenEnv } = credentials;
  const authTokenPlaceholder = resolveAuthTokenPlaceholder(credentials);
  const pluginHeaderTransforms = () => resolveApiHeaderTransforms(manifest);

  const reauthorizeError = () =>
    new CredentialUnavailableError(
      provider,
      `Your ${provider} connection needs to be reauthorized.`,
    );
  const expiredConnectionError = () =>
    new CredentialUnavailableError(
      provider,
      `Your ${provider} connection has expired. Reconnect it to continue.`,
    );

  function buildLease(
    token: string,
    expiresAtMs: number,
    reason: string,
  ): CredentialLease {
    return {
      id: randomUUID(),
      provider,
      env: {
        ...resolvePluginCommandEnv(manifest),
        [authTokenEnv]: authTokenPlaceholder,
      },
      headerTransforms: mergeHeaderTransforms([
        ...pluginHeaderTransforms(),
        ...domains.map((domain) => ({
          domain,
          headers: { ...(apiHeaders ?? {}), Authorization: `Bearer ${token}` },
        })),
      ]),
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: { reason },
    };
  }

  return {
    async issue(input) {
      const envToken = process.env[authTokenEnv]?.trim();
      const oauth = manifest.oauth;
      const userSubjectId = credentialUserSubjectId(input.context);
      if (!oauth) {
        if (envToken) {
          return buildLease(envToken, Date.now() + MAX_LEASE_MS, input.reason);
        }

        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`,
        );
      }

      if (userSubjectId) {
        const connection = await deps.userTokenStore.read(
          userSubjectId,
          provider,
        );
        if (connection?.status === "expired") {
          throw expiredConnectionError();
        }
        const stored = connection?.tokens;
        if (stored) {
          if (!hasRequiredOAuthScope(stored.scope, oauth.scope)) {
            throw reauthorizeError();
          }

          if (shouldRefreshStoredToken(stored)) {
            return await deps.userTokenStore.withRefresh(
              userSubjectId,
              provider,
              async () => {
                const latest = await deps.userTokenStore.get(
                  userSubjectId,
                  provider,
                );
                if (!latest) {
                  throw new CredentialUnavailableError(
                    provider,
                    `No ${provider} credentials available.`,
                  );
                }
                if (!hasRequiredOAuthScope(latest.scope, oauth.scope)) {
                  throw reauthorizeError();
                }
                if (
                  !shouldRefreshStoredToken(latest) &&
                  canUseStoredToken(latest)
                ) {
                  return buildLease(
                    latest.accessToken,
                    getLeaseExpiry(latest.expiresAt),
                    input.reason,
                  );
                }

                let refreshed;
                try {
                  refreshed = await refreshAccessToken(
                    provider,
                    latest.refreshToken,
                    oauth,
                    latest.scope ?? oauth.scope,
                  );
                } catch (error) {
                  if (!(error instanceof OAuthRefreshRejectedError)) {
                    throw error;
                  }
                  await deps.userTokenStore.transition(
                    userSubjectId,
                    provider,
                    { type: "expire", from: latest },
                  );
                  throw expiredConnectionError();
                }
                if (!hasRequiredOAuthScope(refreshed.scope, oauth.scope)) {
                  throw reauthorizeError();
                }
                const refreshedTokens = {
                  ...(latest.refreshTokenExpiresAt
                    ? { refreshTokenExpiresAt: latest.refreshTokenExpiresAt }
                    : undefined),
                  ...refreshed,
                  ...(latest.account ? { account: latest.account } : undefined),
                };
                // A disconnect or reconnect during the refresh wins.
                const saved = await deps.userTokenStore.transition(
                  userSubjectId,
                  provider,
                  { type: "update", from: latest, tokens: refreshedTokens },
                );
                if (!saved) {
                  throw new CredentialUnavailableError(
                    provider,
                    `Your ${provider} connection changed during token refresh. Try again.`,
                  );
                }
                return buildLease(
                  refreshed.accessToken,
                  getLeaseExpiry(refreshed.expiresAt),
                  input.reason,
                );
              },
            );
          }

          if (canUseStoredToken(stored)) {
            return buildLease(
              stored.accessToken,
              getLeaseExpiry(stored.expiresAt),
              input.reason,
            );
          }

          throw expiredConnectionError();
        }

        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`,
        );
      }

      if (envToken) {
        return buildLease(envToken, getLeaseExpiry(), input.reason);
      }

      throw new CredentialUnavailableError(
        provider,
        `No ${provider} credentials available.`,
      );
    },
  };
}
