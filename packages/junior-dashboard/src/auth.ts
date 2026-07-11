import { betterAuth } from "better-auth/minimal";
import { dashboardIdentitySchema } from "./api/schema";
import type { DashboardIdentity } from "./api/schema";
import { resolveDashboardBaseURL } from "./url";

const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

export type DashboardUser = DashboardIdentity["user"];
export type DashboardSession = DashboardIdentity;

export interface DashboardAuthConfig {
  baseURL?: string;
  authPath: string;
  trustedOrigins: string[];
  secret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleHostedDomain?: string;
  sessionMaxAgeSeconds?: number;
}

export interface DashboardAuth {
  handler(request: Request): Promise<Response>;
  getSession(request: Request): Promise<DashboardSession | null>;
  signInWithGoogle(request: Request, callbackURL: string): Promise<Response>;
}

/** Keep dashboard identity responses limited to user display fields. */
export function sanitizeDashboardSession(
  session: DashboardSession,
): DashboardSession {
  const { email, emailVerified, hostedDomain, name } = session.user;
  return dashboardIdentitySchema.parse({
    user: {
      email,
      emailVerified,
      hostedDomain,
      name,
    },
  });
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required for Junior dashboard auth`);
  }
  return value.trim();
}

function firstHostedDomain(domains: string[]): string | undefined {
  return domains.length === 1 ? domains[0] : undefined;
}

/** Create the Better Auth bridge used by dashboard browser routes. */
export function createDashboardAuth(
  config: DashboardAuthConfig,
): DashboardAuth {
  const secret = required(
    config.secret ??
      process.env.BETTER_AUTH_SECRET ??
      process.env.JUNIOR_SECRET,
    "JUNIOR_SECRET or BETTER_AUTH_SECRET",
  );
  const baseURL = resolveDashboardBaseURL({ baseURL: config.baseURL });
  const googleClientId = required(
    config.googleClientId ?? process.env.GOOGLE_CLIENT_ID,
    "GOOGLE_CLIENT_ID",
  );
  const googleClientSecret = required(
    config.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET,
    "GOOGLE_CLIENT_SECRET",
  );

  const auth = betterAuth({
    appName: "Junior Dashboard",
    baseURL,
    basePath: config.authPath,
    secret,
    trustedOrigins: config.trustedOrigins,
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        hd: config.googleHostedDomain,
        prompt: "select_account",
        mapProfileToUser(profile) {
          return {
            email: profile.email,
            emailVerified: profile.email_verified,
            hostedDomain: profile.hd,
            image: profile.picture,
            name: profile.name,
          };
        },
      },
    },
    user: {
      additionalFields: {
        hostedDomain: {
          type: "string",
          required: false,
          input: false,
          returned: true,
        },
      },
    },
    account: {
      storeStateStrategy: "cookie",
      storeAccountCookie: false,
      updateAccountOnSignIn: false,
    },
    session: {
      expiresIn: config.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS,
      disableSessionRefresh: true,
      cookieCache: {
        enabled: true,
        strategy: "jwe",
        maxAge: config.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS,
        refreshCache: false,
      },
    },
  });

  return {
    handler(request) {
      return auth.handler(request);
    },
    async getSession(request) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) {
        return null;
      }
      return sanitizeDashboardSession(session as DashboardSession);
    },
    async signInWithGoogle(request, callbackURL) {
      const result = await auth.api.signInSocial({
        body: {
          provider: "google",
          callbackURL,
        },
        headers: request.headers,
        returnHeaders: true,
      });

      if (!("url" in result.response) || !result.response.url) {
        throw new Error("Google sign-in did not return a redirect URL");
      }

      result.headers.set("location", result.response.url);
      return new Response(null, {
        status: 302,
        headers: result.headers,
      });
    },
  };
}

/** Resolve a Google hosted-domain login hint when it is unambiguous. */
export function resolveGoogleHostedDomainHint(
  domains: string[],
): string | undefined {
  return firstHostedDomain(domains.map((domain) => domain.toLowerCase()));
}
