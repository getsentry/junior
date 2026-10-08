/**
 * Google OAuth for the account that Junior acts as.
 *
 * An admin signs in as the configured account once, out of band. Junior keeps
 * the refresh token in host storage and mints short-lived access tokens from
 * it. Slack never carries the sign-in link, the authorization code, or tokens.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_IDENTITY_SCOPES,
  type GoogleConfig,
} from "./config";
import { saveGoogleAccount, type GoogleDb } from "./store";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

/** A sign-in attempt failed in a way that is safe to show to the admin. */
export class GoogleConnectError extends Error {
  override name = "GoogleConnectError";
}

/** One pending sign-in: the state and PKCE verifier the callback must match. */
export interface GoogleSignInRequest {
  codeVerifier: string;
  state: string;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

type TokenResponse = z.infer<typeof tokenResponseSchema>;

const tokenErrorSchema = z.object({ error: z.string() });

const idTokenClaimsSchema = z.object({
  aud: z.string(),
  email: z.string(),
  email_verified: z.boolean().optional(),
  iss: z.string(),
});

/** Create the random state and PKCE verifier for one sign-in attempt. */
export function createGoogleSignInRequest(): GoogleSignInRequest {
  return {
    codeVerifier: randomBytes(32).toString("base64url"),
    state: randomBytes(24).toString("base64url"),
  };
}

/** Build the Google consent URL for the configured Junior account. */
export function googleAuthorizationUrl(input: {
  config: GoogleConfig;
  redirectUri: string;
  request: GoogleSignInRequest;
}): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  const challenge = createHash("sha256")
    .update(input.request.codeVerifier)
    .digest("base64url");
  url.search = new URLSearchParams({
    access_type: "offline",
    client_id: input.config.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    login_hint: input.config.accountEmail,
    // Always ask for consent so Google returns a refresh token.
    prompt: "consent select_account",
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: [...GOOGLE_IDENTITY_SCOPES, ...GOOGLE_CALENDAR_SCOPES].join(" "),
    state: input.request.state,
  }).toString();
  return url.toString();
}

async function postTokenEndpoint(
  body: Record<string, string>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const response = await fetch(TOKEN_ENDPOINT, {
    body: new URLSearchParams(body),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    return { ok: true, value: parsed };
  }
  const error = tokenErrorSchema.safeParse(parsed);
  return {
    ok: false,
    error: error.success ? error.data.error : `http_${response.status}`,
  };
}

function decodeIdTokenClaims(idToken: string) {
  try {
    const payload = idToken.split(".")[1] ?? "";
    return idTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

function grantedScopes(tokens: TokenResponse): string[] {
  return (tokens.scope ?? "").split(/\s+/).filter(Boolean).sort();
}

/**
 * Check that a sign-in granted the configured account every Calendar scope.
 *
 * The token response comes straight from Google over TLS, so the identity
 * token claims are trusted without a signature check (OpenID Connect Core
 * 3.1.3.7).
 */
function verifyGrant(
  tokens: TokenResponse,
  config: GoogleConfig,
): { refreshToken: string } | { reason: string } {
  const claims = tokens.id_token
    ? decodeIdTokenClaims(tokens.id_token)
    : undefined;
  if (
    !claims ||
    !GOOGLE_ISSUERS.has(claims.iss) ||
    claims.aud !== config.clientId ||
    claims.email_verified !== true
  ) {
    return { reason: "Google did not return a valid account identity." };
  }
  const email = claims.email.toLowerCase();
  if (email !== config.accountEmail) {
    return {
      reason: `You signed in as ${email}. Sign in as ${config.accountEmail} instead.`,
    };
  }
  const granted = new Set(grantedScopes(tokens));
  const missing = GOOGLE_CALENDAR_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    return {
      reason: `Google did not grant every Calendar permission. Start again and allow all requested access. Missing: ${missing.join(", ")}`,
    };
  }
  if (!tokens.refresh_token) {
    return { reason: "Google did not return a refresh token. Start again." };
  }
  return { refreshToken: tokens.refresh_token };
}

/**
 * Exchange an authorization code, verify the account and scopes, and store the
 * refresh token. A grant that fails a check is revoked and never stored.
 */
export async function connectGoogleAccount(input: {
  code: string;
  codeVerifier: string;
  config: GoogleConfig;
  connectedBy: string;
  db: GoogleDb;
  redirectUri: string;
}): Promise<{ accountEmail: string; scope: string }> {
  const result = await postTokenEndpoint({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  if (!result.ok) {
    throw new GoogleConnectError(
      `Google rejected the sign-in (${result.error}). Start again.`,
    );
  }
  const tokens = tokenResponseSchema.parse(result.value);
  const grant = verifyGrant(tokens, input.config);
  if ("reason" in grant) {
    // Best effort: an unstored grant is already unusable to Junior. Revoking
    // only removes it from the signed-in account.
    await fetch(REVOKE_ENDPOINT, {
      body: new URLSearchParams({
        token: tokens.refresh_token ?? tokens.access_token,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }).catch(() => undefined);
    throw new GoogleConnectError(grant.reason);
  }

  const scope = grantedScopes(tokens).join(" ");
  await saveGoogleAccount(input.db, {
    accountEmail: input.config.accountEmail,
    connectedAtMs: Date.now(),
    connectedBy: input.connectedBy,
    refreshToken: grant.refreshToken,
    scope,
  });
  return { accountEmail: input.config.accountEmail, scope };
}

/**
 * Exchange the stored refresh token for a short-lived access token.
 *
 * Returns undefined when Google rejects the refresh token (`invalid_grant`),
 * which means an admin must reconnect the account.
 */
export async function refreshGoogleAccessToken(input: {
  config: GoogleConfig;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresAtMs: number } | undefined> {
  const result = await postTokenEndpoint({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (!result.ok) {
    if (result.error === "invalid_grant") {
      return undefined;
    }
    throw new Error(`Google token refresh failed (${result.error})`);
  }
  const tokens = tokenResponseSchema.parse(result.value);
  return {
    accessToken: tokens.access_token,
    expiresAtMs: Date.now() + tokens.expires_in * 1000,
  };
}
