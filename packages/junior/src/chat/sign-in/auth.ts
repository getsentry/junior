/**
 * Google sign-in session for the dashboard.
 *
 * Better Auth runs the Google OAuth flow and keeps the browser session in an
 * encrypted cookie. With allowed domains, only Google Workspace accounts on
 * those domains can sign in. Each sign-in also saves the native Google
 * identity.
 */
import { createAuthMiddleware } from "better-auth/api";
import { getCookies, getSessionCookie } from "better-auth/cookies";
import { betterAuth } from "better-auth/minimal";
import type { GoogleProfile } from "better-auth/social-providers";
import { decodeJwt } from "jose";
import * as z from "zod";
import { getSqlExecutor } from "@/chat/db";
import { parseAvatarUrl } from "@/chat/identities/avatar";
import {
  GOOGLE_IDENTITY_PROVIDER,
  normalizeIdentityEmail,
} from "@/chat/identities/identity";
import { recordGoogleSignIn } from "@/chat/identities/sql";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { getActiveSpan, getRootSpan } from "@/chat/sentry";
import { readSignInSecret } from "@/chat/secrets";
import { isAllowedDomain, readEnvList } from "./allowlist";
import {
  createDesktopHandoffCode,
  redeemDesktopHandoffCode,
  type SessionCookie,
} from "./desktop-handoff";

const DEFAULT_AUTH_PATH = "/api/auth";
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

/** Set one attribute on the request span that runs this sign-in step. */
function setRequestSpanAttribute(key: string, value: number | string): void {
  const span = getActiveSpan();
  if (span) getRootSpan(span).setAttribute(key, value);
}

// Claims Junior reads from the Google ID token. Google sets `hd` only for
// Google Workspace accounts, so it proves the account belongs to the domain.
// The email domain does not: a personal Google account can use any email.
// Keep the full profile for Better Auth to read the native account subject.
const googleClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  hd: z.string().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

/**
 * Read Google ID token claims. Returns undefined for a malformed token, so
 * Better Auth redirects with `unable_to_get_user_info` instead of a 500.
 */
function readGoogleClaims(idToken: string): GoogleProfile | undefined {
  let payload: GoogleProfile;
  try {
    payload = decodeJwt<GoogleProfile>(idToken);
  } catch {
    return undefined;
  }
  const parsed = googleClaimsSchema.safeParse(payload);
  return parsed.success ? payload : undefined;
}

/** Verified Google account of one browser session. */
export interface SignInSession {
  user: { email: string; emailVerified: boolean; name?: string };
}

/** Browser sign-in routes and session reads. */
export interface SignInAuth {
  handler(request: Request): Promise<Response>;
  getSession(request: Request): Promise<SignInSession | null>;
  signInWithGoogle(
    request: Request,
    callbackURL: string,
    errorCallbackURL?: string,
  ): Promise<Response>;
  /**
   * Encrypt the session cookies of a signed-in request into a desktop sign-in
   * code. Returns undefined when the request has no session cookie.
   */
  createDesktopCode(
    request: Request,
    codeChallenge: string,
  ): Promise<string | undefined>;
  /** Redeem a desktop sign-in code with its PKCE verifier. */
  redeemDesktopCode(
    code: string,
    codeVerifier: string,
  ): Promise<SessionCookie[] | undefined>;
}

/** Settings for the dashboard Google sign-in session. */
export interface SignInAuthConfig {
  agentName: string;
  /** Google Workspace domains that may sign in. Empty allows every account. */
  allowedDomains: string[];
  authPath: string;
  baseURL: string;
  googleClientId?: string;
  googleClientSecret?: string;
  secret?: string;
  sessionMaxAgeSeconds?: number;
  trustedOrigins: string[];
}

/** Dashboard options that also configure the sign-in session. */
export interface SignInAuthOptions {
  authPath?: string;
  baseURL?: string;
  sessionMaxAgeSeconds?: number;
  trustedOrigins?: string[];
}

// Loop instead of a regex, so many slashes cannot make it slow.
function trimSlashes(value: string, leading: boolean): string {
  let start = 0;
  let end = value.length;
  while (leading && start < end && value[start] === "/") start += 1;
  while (end > start && value[end - 1] === "/") end -= 1;
  return value.slice(start, end);
}

function withHttps(host: string): string {
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

/** Resolve sign-in settings from dashboard options and environment. */
export function resolveSignInAuthConfig(
  agentName: string,
  allowedDomains: string[],
  options: SignInAuthOptions = {},
): SignInAuthConfig {
  const authPath = `/${trimSlashes(options.authPath?.trim() || DEFAULT_AUTH_PATH, true)}`;
  const baseURL = trimSlashes(
    withHttps(
      options.baseURL?.trim() || resolveBaseUrl() || "http://localhost:3000",
    ),
    false,
  );
  return {
    agentName,
    allowedDomains,
    authPath,
    baseURL,
    sessionMaxAgeSeconds: options.sessionMaxAgeSeconds,
    trustedOrigins:
      options.trustedOrigins ??
      readEnvList("JUNIOR_DASHBOARD_TRUSTED_ORIGINS") ??
      [],
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required for Junior sign-in`);
  }
  return value.trim();
}

function signInSecret(config: SignInAuthConfig): string {
  return required(
    config.secret ?? readSignInSecret(),
    "JUNIOR_SECRET or BETTER_AUTH_SECRET",
  );
}

// Raw values, not decoded ones: the desktop app sets them back unchanged.
function rawRequestCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0)
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return cookies;
}

function createBetterAuth(config: SignInAuthConfig) {
  const secret = signInSecret(config);
  const sessionMaxAgeSeconds =
    config.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS;
  // `hd` limits the Google account chooser: to the one allowed domain, or to
  // Workspace accounts when more than one domain is allowed. It is only a
  // hint, so `getUserInfo` checks the `hd` claim.
  const { allowedDomains } = config;
  const hostedDomain =
    allowedDomains.length === 0
      ? undefined
      : allowedDomains.length === 1
        ? allowedDomains[0]
        : "*";
  return betterAuth({
    appName: config.agentName,
    baseURL: config.baseURL,
    basePath: config.authPath,
    secret,
    trustedOrigins: config.trustedOrigins,
    socialProviders: {
      google: {
        clientId: required(
          config.googleClientId ?? process.env.GOOGLE_CLIENT_ID,
          "GOOGLE_CLIENT_ID",
        ),
        clientSecret: required(
          config.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET,
          "GOOGLE_CLIENT_SECRET",
        ),
        hd: hostedDomain,
        prompt: "select_account",
        // Junior signs in only through the redirect flow. Turn off direct
        // ID-token sign-in, so `getUserInfo` only reads tokens from Google.
        disableIdTokenSignIn: true,
        // Refresh the name and photo from Google on each sign-in. Without
        // this, Better Auth keeps the values from the first sign-in.
        overrideUserInfoOnSignIn: true,
        // Replaces Better Auth's default, which can check only one `hd`.
        // The ID token comes from Google's token endpoint over TLS, so this
        // reads its claims without a signature check.
        async getUserInfo(token) {
          if (!token.idToken) return null;
          const claims = readGoogleClaims(token.idToken);
          if (!claims) return null;
          if (!isAllowedDomain(claims.hd, allowedDomains)) return null;
          return {
            user: {
              email: claims.email,
              emailVerified: claims.email_verified === true,
              // `null` clears a photo that the person removed.
              image: claims.picture ?? null,
              name: claims.name,
            },
            data: claims,
          };
        },
      },
    },
    account: {
      storeStateStrategy: "cookie",
      storeAccountCookie: false,
      updateAccountOnSignIn: false,
    },
    session: {
      expiresIn: sessionMaxAgeSeconds,
      disableSessionRefresh: true,
      cookieCache: {
        enabled: true,
        strategy: "jwe",
        maxAge: sessionMaxAgeSeconds,
        refreshCache: false,
      },
    },
    hooks: {
      // Save the native Google identity of each sign-in. `getUserInfo`
      // already rejected accounts outside the allowed domains.
      after: createAuthMiddleware(async (ctx) => {
        const created = ctx.context.newSession;
        if (!created || !ctx.path.startsWith("/callback/")) return;
        const email = normalizeIdentityEmail(created.user.email);
        if (!created.user.emailVerified || !email) return;
        const accounts = await ctx.context.internalAdapter.findAccounts(
          created.user.id,
        );
        const google = accounts.find(
          (account) => account.providerId === "google",
        );
        if (!google) {
          throw new Error("Google sign-in has no Google account");
        }
        const nowMs = Date.now();
        const previousSignedInAtMs = await recordGoogleSignIn(
          getSqlExecutor(),
          {
            email,
            subject: google.accountId,
            displayName: created.user.name || undefined,
            avatarUrl: parseAvatarUrl(
              created.user.image,
              GOOGLE_IDENTITY_PROVIDER,
            ),
          },
          nowMs,
        );
        // A sign-in well inside the session lifetime means the browser lost
        // its session, not that the session expired.
        if (previousSignedInAtMs !== undefined) {
          setRequestSpanAttribute(
            "app.sign_in.previous_age_s",
            Math.round((nowMs - previousSignedInAtMs) / 1000),
          );
        }
      }),
    },
  });
}

/**
 * Create the Google sign-in session. Better Auth starts on first use, so apps
 * that never sign in need no Google credentials.
 */
export function createSignInAuth(config: SignInAuthConfig): SignInAuth {
  let auth: ReturnType<typeof createBetterAuth> | undefined;
  const getAuth = () => (auth ??= createBetterAuth(config));
  return {
    handler(request) {
      return getAuth().handler(request);
    },
    async getSession(request) {
      const session = await getAuth().api.getSession({
        headers: request.headers,
      });
      if (!session) return null;
      const { email, emailVerified, name } = session.user;
      return { user: { email, emailVerified, name } };
    },
    async signInWithGoogle(request, callbackURL, errorCallbackURL) {
      // A cookie that reaches here was rejected. Without one, the session
      // expired or this browser never signed in.
      setRequestSpanAttribute(
        "app.sign_in.session_cookie",
        getSessionCookie(request) ? "present" : "missing",
      );
      const result = await getAuth().api.signInSocial({
        body: { provider: "google", callbackURL, errorCallbackURL },
        headers: request.headers,
        returnHeaders: true,
      });
      if (!("url" in result.response) || !result.response.url) {
        throw new Error("Google sign-in did not return a redirect URL");
      }
      result.headers.set("location", result.response.url);
      return new Response(null, { status: 302, headers: result.headers });
    },
    async createDesktopCode(request, codeChallenge) {
      const { sessionToken, sessionData } = getCookies(getAuth().options);
      const cookies = rawRequestCookies(request);
      if (!cookies.has(sessionToken.name)) return undefined;
      // Large cached sessions split into `<name>.0`, `<name>.1`, and so on.
      const kinds = [sessionToken, sessionData];
      const sessionCookies: SessionCookie[] = [];
      for (const [name, value] of cookies) {
        const kind = kinds.find(
          (cookie) =>
            name === cookie.name || name.startsWith(`${cookie.name}.`),
        );
        if (!kind?.attributes.maxAge) continue;
        sessionCookies.push({
          maxAgeSeconds: kind.attributes.maxAge,
          name,
          secure: kind.attributes.secure,
          value,
        });
      }
      return await createDesktopHandoffCode({
        codeChallenge,
        cookies: sessionCookies,
        secret: signInSecret(config),
      });
    },
    async redeemDesktopCode(code, codeVerifier) {
      return await redeemDesktopHandoffCode({
        code,
        codeVerifier,
        secret: signInSecret(config),
      });
    },
  };
}
