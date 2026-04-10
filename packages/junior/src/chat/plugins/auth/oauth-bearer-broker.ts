import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { resolveAuthTokenPlaceholder } from "./auth-token-placeholder";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "./oauth-request";
import type { OAuthBearerCredentials, PluginManifest } from "../types";

const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function refreshAccessToken(
  refreshToken: string,
  oauth: NonNullable<PluginManifest["oauth"]>,
  fallbackScope?: string,
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
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return parseOAuthTokenResponse(data, fallbackScope);
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
      const oauth = manifest.oauth;
      if (!oauth) {
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

      if (input.requesterId) {
        const stored = await deps.userTokenStore.get(
          input.requesterId,
          provider,
        );
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
            } catch (error) {
              if (error instanceof CredentialUnavailableError) {
                throw error;
              }
              if (stored.expiresAt > Date.now()) {
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

        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`,
        );
      }

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
