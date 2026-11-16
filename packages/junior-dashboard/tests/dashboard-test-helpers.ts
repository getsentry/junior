import {
  dashboardBootstrapSchema,
  type DashboardBootstrap,
} from "../src/api/schema";
import type { DashboardAuth, DashboardSession } from "../src/auth";

export const dashboardEnvNames = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "JUNIOR_SECRET",
  "JUNIOR_BASE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "JUNIOR_DASHBOARD_TRUSTED_ORIGINS",
  "JUNIOR_DASHBOARD_MOCK_CONVERSATIONS",
  "SENTRY_DSN",
  "SENTRY_ORG_SLUG",
] as const;

/** Remove dashboard environment overrides between tests. */
export function resetDashboardEnv(): void {
  for (const name of dashboardEnvNames) delete process.env[name];
}

export const DESKTOP_CODE = "desktop-code";
export const DESKTOP_VERIFIER = "v".repeat(43);

/** Build a fixed dashboard auth edge for route tests. */
export function auth(
  session: DashboardSession | null,
  onSignIn?: (callbackURL: string, errorCallbackURL: string) => void,
): DashboardAuth {
  return {
    async handler() {
      return Response.json({ ok: true });
    },
    async getSession() {
      return session;
    },
    async signInWithGoogle(_request, callbackURL, errorCallbackURL) {
      onSignIn?.(callbackURL, errorCallbackURL);
      return Response.redirect(
        "https://accounts.google.com/o/oauth2/v2/auth",
        302,
      );
    },
    async createDesktopCode() {
      return session ? DESKTOP_CODE : undefined;
    },
    async redeemDesktopCode(code, codeVerifier) {
      return code === DESKTOP_CODE && codeVerifier === DESKTOP_VERIFIER
        ? [{ maxAgeSeconds: 60, name: "session", secure: true, value: "s" }]
        : undefined;
    },
  };
}

/** Read the core data the page shell embeds for the client's first render. */
export function embeddedBootstrap(
  html: string,
): DashboardBootstrap | undefined {
  const match = /window\.__JUNIOR_DASHBOARD_BOOTSTRAP__ = (.*);\n/.exec(html);
  return match
    ? dashboardBootstrapSchema.parse(JSON.parse(match[1]!))
    : undefined;
}
