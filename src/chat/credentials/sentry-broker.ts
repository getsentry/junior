import { randomUUID } from "node:crypto";
import type { CapabilityTarget } from "@/chat/capabilities/types";
import { CredentialUnavailableError, type CredentialBroker, type CredentialLease } from "@/chat/credentials/broker";
import type { StoredTokens, UserTokenStore } from "@/chat/credentials/user-token-store";

// Spec: specs/skill-capabilities-spec.md (Sentry broker behavior)
// Spec: specs/security-policy.md (per-user OAuth credential issuance)

const SENTRY_API_DOMAIN = "sentry.io";
const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const SUPPORTED_CAPABILITIES = new Set([
  "sentry.issues.read",
  "sentry.events.read",
  "sentry.replays.read"
]);

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const clientId = process.env.SENTRY_CLIENT_ID?.trim();
  const clientSecret = process.env.SENTRY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Missing SENTRY_CLIENT_ID or SENTRY_CLIENT_SECRET for token refresh");
  }

  const response = await fetch("https://sentry.io/oauth/token/", {
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
    throw new Error(`Sentry token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("Sentry token refresh returned malformed response");
  }

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in
  };
}

function buildLease(token: string, capability: string, expiresAtMs: number, reason: string): CredentialLease {
  return {
    id: randomUUID(),
    provider: "sentry",
    capability,
    env: { SENTRY_AUTH_TOKEN: token },
    headerTransforms: [
      {
        domain: SENTRY_API_DOMAIN,
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    ],
    expiresAt: new Date(expiresAtMs).toISOString(),
    metadata: { reason }
  };
}

export class SentryCredentialBroker implements CredentialBroker {
  private readonly userTokenStore?: UserTokenStore;

  constructor(params?: { userTokenStore?: UserTokenStore }) {
    this.userTokenStore = params?.userTokenStore;
  }

  async issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
    requesterId?: string;
  }): Promise<CredentialLease> {
    if (!SUPPORTED_CAPABILITIES.has(input.capability)) {
      throw new Error(`Unsupported Sentry capability: ${input.capability}`);
    }

    // 1. Per-user OAuth token
    if (input.requesterId && this.userTokenStore) {
      const stored = await this.userTokenStore.get(input.requesterId, "sentry");
      if (stored) {
        const now = Date.now();
        // Refresh if within buffer of expiry
        if (stored.expiresAt - now < REFRESH_BUFFER_MS && stored.refreshToken) {
          try {
            const refreshed = await refreshAccessToken(stored.refreshToken);
            const expiresAt = Date.now() + refreshed.expiresIn * 1000;
            await this.userTokenStore.set(input.requesterId, "sentry", {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt
            });
            const leaseExpiry = Math.min(expiresAt, Date.now() + MAX_LEASE_MS);
            return buildLease(refreshed.accessToken, input.capability, leaseExpiry, input.reason);
          } catch {
            // Refresh failed — if the current token is still valid, use it
            // rather than forcing re-auth on a transient network error.
            if (stored.expiresAt > Date.now()) {
              const leaseExpiry = Math.min(stored.expiresAt, Date.now() + MAX_LEASE_MS);
              return buildLease(stored.accessToken, input.capability, leaseExpiry, input.reason);
            }
            throw new CredentialUnavailableError(
              "sentry",
              "Your Sentry connection has expired. Reconnect with /sentry auth."
            );
          }
        }

        if (stored.expiresAt > Date.now()) {
          const leaseExpiry = Math.min(stored.expiresAt, Date.now() + MAX_LEASE_MS);
          return buildLease(stored.accessToken, input.capability, leaseExpiry, input.reason);
        }

        throw new CredentialUnavailableError(
          "sentry",
          "Your Sentry connection has expired. Reconnect with /sentry auth."
        );
      }
    }

    // 2. Static env fallback
    const envToken = process.env.SENTRY_AUTH_TOKEN?.trim();
    if (envToken) {
      const expiresAtMs = Date.now() + MAX_LEASE_MS;
      return buildLease(envToken, input.capability, expiresAtMs, input.reason);
    }

    throw new CredentialUnavailableError(
      "sentry",
      "No Sentry credentials available. Use `/sentry auth` to connect your Sentry account, or set SENTRY_AUTH_TOKEN."
    );
  }
}
