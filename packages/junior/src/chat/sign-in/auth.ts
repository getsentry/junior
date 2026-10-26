/**
 * Google sign-in session shared by the dashboard and Slack.
 *
 * Better Auth runs the Google OAuth flow and keeps the browser session in an
 * encrypted cookie. Each sign-in also saves the native Google identity with its
 * sign-in time, so Slack can check a recent sign-in without the browser.
 */
import { createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { recordGoogleSignIn } from "@/chat/identities/sql";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import {
  isSignInAllowed,
  readEnvList,
  resolveSignInAllowlist,
  type SignInAllowlist,
} from "./allowlist";

const DEFAULT_AUTH_PATH = "/api/auth";
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

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
  allowlist: SignInAllowlist;
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
  allowedEmails?: string[];
  allowedGoogleDomains?: string[];
  authPath?: string;
  baseURL?: string;
  sessionMaxAgeSeconds?: number;
  trustedOrigins?: string[];
}

function withHttps(host: string): string {
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

/** Resolve sign-in settings from dashboard options and environment. */
export function resolveSignInAuthConfig(
  agentName: string,
  options: SignInAuthOptions = {},
): SignInAuthConfig {
  const authPath = `/${(options.authPath?.trim() || DEFAULT_AUTH_PATH).replace(/^\/+|\/+$/g, "")}`;
  const baseURL = withHttps(
    options.baseURL?.trim() || resolveBaseUrl() || "http://localhost:3000",
  ).replace(/\/+$/, "");
  return {
    agentName,
    allowlist: resolveSignInAllowlist(options),
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
  // Google rejects other accounts when `hd` is set, so set it only when the
  // allowlist is one domain.
  const { domains, emails } = config.allowlist;
  const hostedDomain =
    domains.length === 1 && emails.length === 0 ? domains[0] : undefined;
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
        mapProfileToUser(profile) {
          return {
            email: profile.email,
            emailVerified: profile.email_verified,
            image: profile.picture,
            name: profile.name,
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
      // Save each allowed Google sign-in, so Slack can check it later.
      after: createAuthMiddleware(async (ctx) => {
        const created = ctx.context.newSession;
        if (!created || !ctx.path.startsWith("/callback/")) return;
        const email = normalizeIdentityEmail(created.user.email);
        if (
          !created.user.emailVerified ||
          !email ||
          !isSignInAllowed(email, config.allowlist)
        ) {
          return;
        }
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
 * Create the shared Google sign-in session. Better Auth starts on first use,
 * so apps that never sign in need no Google credentials.
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
