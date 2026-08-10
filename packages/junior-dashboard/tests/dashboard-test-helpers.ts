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
  "JUNIOR_DASHBOARD_AUTH_REQUIRED",
  "JUNIOR_DASHBOARD_COMPONENT_GALLERY",
  "JUNIOR_DASHBOARD_GOOGLE_DOMAINS",
  "JUNIOR_DASHBOARD_ALLOWED_EMAILS",
  "JUNIOR_DASHBOARD_TRUSTED_ORIGINS",
  "JUNIOR_DASHBOARD_MOCK_CONVERSATIONS",
  "SENTRY_DSN",
  "SENTRY_ORG_SLUG",
] as const;

/** Remove dashboard environment overrides between tests. */
export function resetDashboardEnv(): void {
  for (const name of dashboardEnvNames) delete process.env[name];
}

/** Build a fixed dashboard auth edge for route tests. */
export function auth(
  session: DashboardSession | null,
  onSignIn?: (callbackURL: string) => void,
): DashboardAuth {
  return {
    async handler() {
      return Response.json({ ok: true });
    },
    async getSession() {
      return session;
    },
    async signInWithGoogle(_request, callbackURL) {
      onSignIn?.(callbackURL);
      return Response.redirect(
        "https://accounts.google.com/o/oauth2/v2/auth",
        302,
      );
    },
  };
}
