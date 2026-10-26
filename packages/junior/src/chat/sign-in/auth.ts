/**
 * Google sign-in session for the dashboard.
 *
 * Better Auth runs the Google OAuth flow and keeps the browser session in an
 * encrypted cookie. With allowed domains, only Google Workspace accounts on
 * those domains can sign in. Each sign-in also saves the native Google
 * identity.
 */
import { createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { decodeJwt } from "jose";
import { z } from "zod";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { recordGoogleSignIn } from "@/chat/identities/sql";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import {
  isAllowedDomain,
  readEnvList,
  resolveAllowedDomains,
} from "./allowlist";

const DEFAULT_AUTH_PATH = "/api/auth";
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

// Claims Junior reads from the Google ID token. Google sets `hd` only for
// Google Workspace accounts, so it proves the account belongs to the domain.
// The email domain does not: a personal Google account can use any email.
const googleClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  hd: z.string().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

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
}

/** Settings for the shared Google sign-in session. */
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
  allowedGoogleDomains?: string[];
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
    allowedDomains: resolveAllowedDomains(options),
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

function createBetterAuth(config: SignInAuthConfig) {
  const secret = required(
    config.secret ??
      process.env.BETTER_AUTH_SECRET ??
      process.env.JUNIOR_SECRET,
    "JUNIOR_SECRET or BETTER_AUTH_SECRET",
  );
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
        // Replaces Better Auth's default, which can check only one `hd`.
        // The ID token comes from Google's token endpoint over TLS, or was
        // verified by `verifyIdToken` first.
        async getUserInfo(token) {
          if (!token.idToken) return null;
          const parsed = googleClaimsSchema.safeParse(decodeJwt(token.idToken));
          if (!parsed.success) return null;
          const claims = parsed.data;
          if (!isAllowedDomain(claims.hd, allowedDomains)) return null;
          return {
            user: {
              id: claims.sub,
              email: claims.email,
              emailVerified: claims.email_verified === true,
              image: claims.picture,
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
        await recordGoogleSignIn(getSqlExecutor(), {
          email,
          subject: google.accountId,
          displayName: created.user.name || undefined,
        });
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
  };
}
