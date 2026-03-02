import { randomUUID } from "node:crypto";
import type { CredentialBroker, CredentialLease } from "@/chat/credentials/broker";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import type { OAuthBearerCredentials, PluginManifest } from "./types";

const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const AUTH_TOKEN_PLACEHOLDER = "host_managed_credential";

async function refreshAccessToken(
  refreshToken: string,
  oauth: NonNullable<PluginManifest["oauth"]>
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const clientId = process.env[oauth.clientIdEnv]?.trim();
  const clientSecret = process.env[oauth.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(`Missing ${oauth.clientIdEnv} or ${oauth.clientSecretEnv} for token refresh`);
  }

  const response = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("Token refresh returned malformed response");
  }

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in
  };
}

export function createOAuthBearerBroker(
  manifest: PluginManifest,
  credentials: OAuthBearerCredentials,
  deps: { userTokenStore: UserTokenStore }
): CredentialBroker {
  const provider = manifest.name;
  const supportedCapabilities = new Set(manifest.capabilities);
  const { apiDomains, authTokenEnv } = credentials;

  function buildLease(token: string, capability: string, expiresAtMs: number, reason: string): CredentialLease {
    return {
      id: randomUUID(),
      provider,
      capability,
      env: { [authTokenEnv]: AUTH_TOKEN_PLACEHOLDER },
      headerTransforms: apiDomains.map((domain) => ({
        domain,
        headers: { Authorization: `Bearer ${token}` }
      })),
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: { reason }
    };
  }

  return {
    async issue(input) {
      if (!supportedCapabilities.has(input.capability)) {
        throw new Error(`Unsupported ${provider} capability: ${input.capability}`);
      }

      // 1. Per-user OAuth token (preferred when requester context exists)
      if (input.requesterId && deps.userTokenStore) {
        const stored = await deps.userTokenStore.get(input.requesterId, provider);
        if (stored) {
          const now = Date.now();
          // Refresh if within buffer of expiry
          if (stored.expiresAt - now < REFRESH_BUFFER_MS && stored.refreshToken && manifest.oauth) {
            try {
              const refreshed = await refreshAccessToken(stored.refreshToken, manifest.oauth);
              const expiresAt = Date.now() + refreshed.expiresIn * 1000;
              await deps.userTokenStore.set(input.requesterId, provider, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresAt
              });
              const leaseExpiry = Math.min(expiresAt, Date.now() + MAX_LEASE_MS);
              return buildLease(refreshed.accessToken, input.capability, leaseExpiry, input.reason);
            } catch {
              // Refresh failed — if the current token is still valid, use it
              if (stored.expiresAt > Date.now()) {
                const leaseExpiry = Math.min(stored.expiresAt, Date.now() + MAX_LEASE_MS);
                return buildLease(stored.accessToken, input.capability, leaseExpiry, input.reason);
              }
              throw new CredentialUnavailableError(
                provider,
                `Your ${provider} connection has expired.`
              );
            }
          }

          if (stored.expiresAt > Date.now()) {
            const leaseExpiry = Math.min(stored.expiresAt, Date.now() + MAX_LEASE_MS);
            return buildLease(stored.accessToken, input.capability, leaseExpiry, input.reason);
          }

          throw new CredentialUnavailableError(
            provider,
            `Your ${provider} connection has expired.`
          );
        }

        // User has requester context but no stored token — require OAuth.
        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`
        );
      }

      // 2. Static env fallback — only used when there is no requester context
      const envToken = process.env[authTokenEnv]?.trim();
      if (envToken) {
        const expiresAtMs = Date.now() + MAX_LEASE_MS;
        return buildLease(envToken, input.capability, expiresAtMs, input.reason);
      }

      throw new CredentialUnavailableError(
        provider,
        `No ${provider} credentials available.`
      );
    }
  };
}
