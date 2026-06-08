import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { credentialUserSubjectId } from "@/chat/credentials/context";
import { mergeHeaderTransforms } from "@/chat/credentials/header-transforms";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
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
  refreshToken: string,
  oauth: NonNullable<PluginManifest["oauth"]>,
  requestedScope?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
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
  const response = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });

  if (!response.ok) {
    const errorCode = parseRefreshError(await response.text());
    if (errorCode === "invalid_grant" || errorCode === "bad_refresh_token") {
      throw new OAuthRefreshRejectedError(
        `Token refresh rejected: ${errorCode}`,
      );
    }
    throw new Error(
      `Token refresh failed: ${response.status}${errorCode ? ` ${errorCode}` : ""}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  return parseOAuthTokenResponse(data, requestedScope, {
    treatEmptyScopeAsUnreported: oauth.treatEmptyScopeAsUnreported,
  });
}

function getLeaseExpiry(expiresAt?: number): number {
  return expiresAt
    ? Math.min(expiresAt, Date.now() + MAX_LEASE_MS)
    : Date.now() + MAX_LEASE_MS;
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
        const stored = await deps.userTokenStore.get(userSubjectId, provider);
        if (stored) {
          if (!hasRequiredOAuthScope(stored.scope, oauth.scope)) {
            throw new CredentialUnavailableError(
              provider,
              `Your ${provider} connection needs to be reauthorized.`,
            );
          }

          const now = Date.now();
          if (
            stored.expiresAt !== undefined &&
            stored.expiresAt - now < REFRESH_BUFFER_MS
          ) {
            try {
              const refreshed = await refreshAccessToken(
                stored.refreshToken,
                oauth,
                stored.scope ?? oauth.scope,
              );
              if (!hasRequiredOAuthScope(refreshed.scope, oauth.scope)) {
                throw new CredentialUnavailableError(
                  provider,
                  `Your ${provider} connection needs to be reauthorized.`,
                );
              }
              const refreshedTokens = {
                ...refreshed,
                ...(stored.account ? { account: stored.account } : {}),
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

          if (stored.expiresAt === undefined || stored.expiresAt > Date.now()) {
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
