import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import {
  CredentialUnavailableError,
  ServiceAccountUnavailableError,
} from "@/chat/credentials/broker";
import { credentialUserSubjectId } from "@/chat/credentials/context";
import {
  serviceAccountAllows,
  serviceAccountOnly,
} from "@/chat/credentials/service-account";
import { logWarn } from "@/chat/logging";
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
  deleteOAuthServiceAccountCredentials,
  getOAuthServiceAccountCredentials,
  putOAuthServiceAccountCredentials,
  withOAuthServiceAccountLock,
  type OAuthServiceAccountCredentials,
} from "./oauth-service-account";
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
  expiresAt?: number | undefined;
  refreshTokenExpiresAt?: number | undefined;
  scope?: string | undefined;
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

function canUseStoredToken<T extends Pick<StoredTokens, "expiresAt">>(
  stored: T | undefined,
): stored is T {
  return (
    stored !== undefined &&
    (stored.expiresAt === undefined || stored.expiresAt > Date.now())
  );
}

function shouldRefreshStoredToken(
  stored: Pick<StoredTokens, "expiresAt"> | undefined,
): boolean {
  return (
    stored !== undefined &&
    stored.expiresAt !== undefined &&
    stored.expiresAt - Date.now() < REFRESH_BUFFER_MS
  );
}

/**
 * Return a usable token of the plugin's OAuth service account, refreshing it
 * when it is about to expire. Returns nothing when no Admin connected it, or
 * when the provider rejected it, which removes the stored account.
 */
async function serviceAccountToken(
  provider: string,
  oauth: NonNullable<PluginManifest["oauth"]>,
): Promise<OAuthServiceAccountCredentials | undefined> {
  const stored = await getOAuthServiceAccountCredentials(provider);
  if (!shouldRefreshStoredToken(stored) || !stored?.refreshToken) {
    return canUseStoredToken(stored) ? stored : undefined;
  }
  return await withOAuthServiceAccountLock(provider, async (fence) => {
    const latest = await getOAuthServiceAccountCredentials(provider);
    if (!shouldRefreshStoredToken(latest) || !latest?.refreshToken) {
      return canUseStoredToken(latest) ? latest : undefined;
    }
    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
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
      await fence();
      await deleteOAuthServiceAccountCredentials(provider);
      logWarn("oauth.service_account.disconnected", {
        "app.plugin.name": provider,
      });
      return undefined;
    }
    const next = { ...latest, ...refreshed };
    await fence();
    await putOAuthServiceAccountCredentials(provider, next);
    return next;
  });
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

  function buildLease(
    token: string,
    expiresAtMs: number,
    reason: string,
  ): CredentialLease {
    const env = resolvePluginCommandEnv(manifest);
    if (authTokenEnv) {
      env[authTokenEnv] = authTokenPlaceholder;
    }
    return {
      id: randomUUID(),
      provider,
      env,
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
      const envToken = authTokenEnv
        ? process.env[authTokenEnv]?.trim()
        : undefined;
      const oauth = manifest.oauth;
      const userSubjectId = credentialUserSubjectId(input.context);
      // Only plugin host code names an operation, so sandbox commands never
      // get the service account.
      const serviceAccountMayServe =
        input.operation !== undefined &&
        serviceAccountAllows(manifest, { operation: input.operation });
      const serviceAccountLease = async () => {
        const token =
          serviceAccountMayServe && oauth
            ? await serviceAccountToken(provider, oauth)
            : undefined;
        return token
          ? buildLease(
              token.accessToken,
              getLeaseExpiry(token.expiresAt),
              input.reason,
            )
          : undefined;
      };
      if (!oauth) {
        if (envToken) {
          return buildLease(envToken, Date.now() + MAX_LEASE_MS, input.reason);
        }

        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`,
        );
      }

      if (serviceAccountOnly(manifest)) {
        const lease = await serviceAccountLease();
        if (lease) {
          return lease;
        }
        throw new ServiceAccountUnavailableError(
          provider,
          serviceAccountMayServe
            ? `The ${provider} service account is not connected. An admin must connect it on the dashboard Admin page.`
            : `The ${provider} service account does not allow this request.`,
        );
      }

      if (userSubjectId) {
        const stored = await deps.userTokenStore.get(userSubjectId, provider);
        if (stored) {
          if (!hasRequiredOAuthScope(stored.scope, oauth.scope)) {
            throw new CredentialUnavailableError(
              provider,
              `Your ${provider} connection needs to be reauthorized.`,
            );
          }

          if (shouldRefreshStoredToken(stored)) {
            try {
              return await deps.userTokenStore.withRefresh(
                userSubjectId,
                provider,
                async () => {
                  const latest = await deps.userTokenStore.get(
                    userSubjectId,
                    provider,
                  );
                  if (
                    latest &&
                    !hasRequiredOAuthScope(latest.scope, oauth.scope)
                  ) {
                    throw new CredentialUnavailableError(
                      provider,
                      `Your ${provider} connection needs to be reauthorized.`,
                    );
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
                  if (!latest) {
                    throw new CredentialUnavailableError(
                      provider,
                      `No ${provider} credentials available.`,
                    );
                  }

                  const refreshed = await refreshAccessToken(
                    provider,
                    latest.refreshToken,
                    oauth,
                    latest.scope ?? oauth.scope,
                  );
                  if (!hasRequiredOAuthScope(refreshed.scope, oauth.scope)) {
                    throw new CredentialUnavailableError(
                      provider,
                      `Your ${provider} connection needs to be reauthorized.`,
                    );
                  }
                  const refreshedTokens = {
                    ...(latest.refreshTokenExpiresAt
                      ? { refreshTokenExpiresAt: latest.refreshTokenExpiresAt }
                      : undefined),
                    ...refreshed,
                    ...(latest.account
                      ? { account: latest.account }
                      : undefined),
                  };
                  await deps.userTokenStore.set(
                    userSubjectId,
                    provider,
                    refreshedTokens,
                  );
                  return buildLease(
                    refreshed.accessToken,
                    getLeaseExpiry(refreshed.expiresAt),
                    input.reason,
                  );
                },
              );
            } catch (error) {
              if (error instanceof CredentialUnavailableError) {
                throw error;
              }
              if (error instanceof OAuthRefreshRejectedError) {
                throw new CredentialUnavailableError(
                  provider,
                  `Your ${provider} connection has expired.`,
                );
              }
              throw error;
            }
          }

          if (canUseStoredToken(stored)) {
            return buildLease(
              stored.accessToken,
              getLeaseExpiry(stored.expiresAt),
              input.reason,
            );
          }

          throw new CredentialUnavailableError(
            provider,
            `Your ${provider} connection has expired.`,
          );
        }

        const lease = await serviceAccountLease();
        if (lease) {
          return lease;
        }
        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`,
        );
      }

      const lease = await serviceAccountLease();
      if (lease) {
        return lease;
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
