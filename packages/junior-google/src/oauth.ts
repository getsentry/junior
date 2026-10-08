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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GoogleConnectError";
  }
}

/** Google rejected the stored refresh token. An admin must reconnect. */
export class GoogleTokenRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTokenRejectedError";
  }
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

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const idTokenClaimsSchema = z.object({
  aud: z.string(),
  email: z.string(),
  email_verified: z.boolean().optional(),
  iss: z.string(),
});

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** Create the random state and PKCE verifier for one sign-in attempt. */
export function createGoogleSignInRequest(): GoogleSignInRequest {
  return {
    codeVerifier: base64Url(randomBytes(32)),
    state: base64Url(randomBytes(24)),
  };
}

/** Build the Google consent URL for the configured Junior account. */
export function googleAuthorizationUrl(input: {
  config: GoogleConfig;
  redirectUri: string;
  request: GoogleSignInRequest;
}): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  const challenge = base64Url(
    createHash("sha256").update(input.request.codeVerifier).digest(),
  );
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
  const payload = idToken.split(".")[1];
  if (!payload) {
    throw new GoogleConnectError("Google returned a malformed identity token.");
  }
  try {
    return idTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch (error) {
    throw new GoogleConnectError(
      "Google returned a malformed identity token.",
      {
        cause: error,
      },
    );
  }
}

async function revokeToken(token: string) {
  // Best effort: the grant is already unusable to Junior because it is not
  // stored. Revoking only removes it from the signed-in account.
  await fetch(REVOKE_ENDPOINT, {
    body: new URLSearchParams({ token }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  }).catch(() => undefined);
}

/**
 * Exchange an authorization code, verify the account and scopes, and store the
 * refresh token.
 *
 * The token response comes straight from Google over TLS, so the identity
 * token claims are trusted without a signature check (OpenID Connect Core
 * 3.1.3.7).
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
  const grantedToken = tokens.refresh_token ?? tokens.access_token;

  if (!tokens.id_token) {
    await revokeToken(grantedToken);
    throw new GoogleConnectError("Google did not return the account identity.");
  }
  const claims = decodeIdTokenClaims(tokens.id_token);
  const email = claims.email.toLowerCase();
  if (
    !GOOGLE_ISSUERS.has(claims.iss) ||
    claims.aud !== input.config.clientId ||
    claims.email_verified !== true
  ) {
    await revokeToken(grantedToken);
    throw new GoogleConnectError("Google returned an unexpected identity.");
  }
  if (email !== input.config.accountEmail) {
    await revokeToken(grantedToken);
    throw new GoogleConnectError(
      `You signed in as ${email}. Sign in as ${input.config.accountEmail} instead.`,
    );
  }

  const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
  const missing = GOOGLE_CALENDAR_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    await revokeToken(grantedToken);
    throw new GoogleConnectError(
      `Google did not grant every Calendar permission. Start again and allow all requested access. Missing: ${missing.join(", ")}`,
    );
  }
  if (!tokens.refresh_token) {
    await revokeToken(grantedToken);
    throw new GoogleConnectError(
      "Google did not return a refresh token. Start again.",
    );
  }

  const scope = [...granted].sort().join(" ");
  await saveGoogleAccount(input.db, {
    accountEmail: email,
    connectedAtMs: Date.now(),
    connectedBy: input.connectedBy,
    refreshToken: tokens.refresh_token,
    scope,
  });
  return { accountEmail: email, scope };
}

/** Exchange the stored refresh token for a short-lived access token. */
export async function refreshGoogleAccessToken(input: {
  config: GoogleConfig;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresAtMs: number }> {
  const result = await postTokenEndpoint({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (!result.ok) {
    if (result.error === "invalid_grant") {
      throw new GoogleTokenRejectedError(
        "Google rejected Junior's stored refresh token.",
      );
    }
    throw new Error(`Google token refresh failed (${result.error})`);
  }
  const tokens = tokenResponseSchema.parse(result.value);
  return {
    accessToken: tokens.access_token,
    expiresAtMs: Date.now() + tokens.expires_in * 1000,
  };
}
