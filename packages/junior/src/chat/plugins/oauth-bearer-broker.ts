import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { resolveAuthTokenPlaceholder } from "./auth-token-placeholder";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "./oauth-request";
import type { OAuthBearerCredentials, PluginManifest } from "./types";

const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function refreshAccessToken(
  refreshToken: string,
  oauth: NonNullable<PluginManifest["oauth"]>,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
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
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return parseOAuthTokenResponse(data);
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
  const supportedCapabilities = new Set(manifest.capabilities);
  const { apiDomains, apiHeaders, authTokenEnv } = credentials;
  const authTokenPlaceholder = resolveAuthTokenPlaceholder(credentials);

  function buildLease(
    token: string,
    capability: string,
    expiresAtMs: number,
    reason: string,
  ): CredentialLease {
    return {
      id: randomUUID(),
      provider,
      capability,
      env: { [authTokenEnv]: authTokenPlaceholder },
      headerTransforms: apiDomains.map((domain) => ({
        domain,
        headers: { ...(apiHeaders ?? {}), Authorization: `Bearer ${token}` },
      })),
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: { reason },
    };
  }

  return {
    async issue(input) {
      if (!supportedCapabilities.has(input.capability)) {
        throw new Error(
          `Unsupported ${provider} capability: ${input.capability}`,
        );
      }

      const envToken = process.env[authTokenEnv]?.trim();
      if (!manifest.oauth) {
        if (envToken) {
          return buildLease(
            envToken,
            input.capability,
            Date.now() + MAX_LEASE_MS,
            input.reason,
          );
        }

        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`,
        );
      }

      // 1. Per-user OAuth token (preferred when requester context exists)
      if (input.requesterId && deps.userTokenStore) {
        const stored = await deps.userTokenStore.get(
          input.requesterId,
          provider,
        );
        if (stored) {
          const now = Date.now();
          // Refresh if within buffer of expiry
          if (
            stored.expiresAt !== undefined &&
            stored.expiresAt - now < REFRESH_BUFFER_MS &&
            manifest.oauth
          ) {
            try {
              const refreshed = await refreshAccessToken(
                stored.refreshToken,
                manifest.oauth,
              );
              await deps.userTokenStore.set(
                input.requesterId,
                provider,
                refreshed,
              );
              return buildLease(
                refreshed.accessToken,
                input.capability,
                getLeaseExpiry(refreshed.expiresAt),
                input.reason,
              );
            } catch {
              if (
                stored.expiresAt === undefined ||
                stored.expiresAt > Date.now()
              ) {
                return buildLease(
                  stored.accessToken,
                  input.capability,
                  getLeaseExpiry(stored.expiresAt),
                  input.reason,
                );
              }
              throw new CredentialUnavailableError(
                provider,
                `Your ${provider} connection has expired.`,
              );
            }
          }

          if (stored.expiresAt === undefined || stored.expiresAt > Date.now()) {
            return buildLease(
              stored.accessToken,
              input.capability,
              getLeaseExpiry(stored.expiresAt),
              input.reason,
            );
          }

          throw new CredentialUnavailableError(
            provider,
            `Your ${provider} connection has expired.`,
          );
        }

        // User has requester context but no stored token — require OAuth.
        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`,
        );
      }

      // 2. Static env fallback — only used when there is no requester context
      if (envToken) {
        return buildLease(
          envToken,
          input.capability,
          getLeaseExpiry(),
          input.reason,
        );
      }

      throw new CredentialUnavailableError(
        provider,
        `No ${provider} credentials available.`,
      );
    },
  };
}
