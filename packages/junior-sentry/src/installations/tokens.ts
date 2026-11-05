/**
 * Tokens for installations of Junior's Sentry public integration.
 *
 * Sentry gives the first token for a grant code from the install webhook.
 * After that, Junior mints a new token with a JWT signed with the client
 * secret, so it never stores a refresh token. Each mint deletes the previous
 * token of the installation, so the plugin cache shares one token across
 * instances and its load lock serializes mints.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { PluginCache } from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Client credentials of the public integration. */
export interface SentryAppConfig {
  clientId: string;
  clientSecret: string;
}

/** One installation token and when Sentry expires it. */
export interface SentryInstallationToken {
  expiresAtMs: number;
  token: string;
}

// Tokens last 8 hours. Mint a new one well before that, so a request never
// sends a token that expires on the way.
const TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;
const JWT_LIFETIME_SECONDS = 60;
const JWT_BEARER_GRANT = "urn:sentry:params:oauth:grant-type:jwt-bearer";

const tokenResponseSchema = z.object({
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  token: z.string().min(1),
});

/** Read the public integration client credentials, when configured. */
export function sentryAppConfig(): SentryAppConfig | undefined {
  const clientId = process.env.SENTRY_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.SENTRY_APP_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function authorizationsUrl(installationUuid: string): string {
  return `https://sentry.io/api/0/sentry-app-installations/${encodeURIComponent(installationUuid)}/authorizations/`;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** Sign the short-lived client JWT that Sentry accepts for a token mint. */
function clientJwt(config: SentryAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      exp: now + JWT_LIFETIME_SECONDS,
      iat: now,
      iss: config.clientId,
      jti: randomUUID(),
      sub: config.clientId,
    }),
  );
  const signature = createHmac("sha256", config.clientSecret)
    .update(`${header}.${claims}`)
    .digest("base64url");
  return `${header}.${claims}.${signature}`;
}

async function requestToken(
  installationUuid: string,
  init: { body: Record<string, string>; headers?: Record<string, string> },
): Promise<SentryInstallationToken> {
  const response = await fetch(authorizationsUrl(installationUuid), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: JSON.stringify(init.body),
  });
  if (!response.ok) {
    throw new Error(
      `Sentry rejected the token request for installation ${installationUuid} with HTTP ${response.status}.`,
    );
  }
  const parsed = tokenResponseSchema.parse(await response.json());
  return { expiresAtMs: Date.parse(parsed.expiresAt), token: parsed.token };
}

function cacheEntry(token: SentryInstallationToken) {
  const ttlMs = token.expiresAtMs - Date.now() - TOKEN_REFRESH_MARGIN_MS;
  return { value: token, ...(ttlMs > 0 ? { ttlMs } : undefined) };
}

function tokenCacheKey(installationUuid: string): string {
  return `installation-token:${installationUuid}`;
}

/**
 * Exchange the grant code from an install webhook for the first token, and
 * keep it in the cache for egress.
 */
export async function exchangeSentryGrantCode(
  cache: PluginCache,
  config: SentryAppConfig,
  installation: { code: string; installationUuid: string },
): Promise<void> {
  await cache.getOrLoad(
    tokenCacheKey(installation.installationUuid),
    async () =>
      cacheEntry(
        await requestToken(installation.installationUuid, {
          body: {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: installation.code,
            grant_type: "authorization_code",
          },
        }),
      ),
    { refresh: true },
  );
}

/** Return a current token for one installation, and mint one when needed. */
export async function sentryInstallationToken(
  cache: PluginCache,
  config: SentryAppConfig,
  installationUuid: string,
): Promise<SentryInstallationToken> {
  return await cache.getOrLoad(tokenCacheKey(installationUuid), async () =>
    cacheEntry(
      await requestToken(installationUuid, {
        body: { grant_type: JWT_BEARER_GRANT },
        headers: { Authorization: `Bearer ${clientJwt(config)}` },
      }),
    ),
  );
}
