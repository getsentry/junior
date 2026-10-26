import { dashboardSessionSchema } from "./api/schema";
import type { DashboardSession } from "./api/schema";

export type DashboardUser = DashboardSession["user"];
export type { DashboardSession };

/** Google sign-in session that core shares with Slack. */
export interface DashboardAuth {
  handler(request: Request): Promise<Response>;
  getSession(request: Request): Promise<DashboardSession | null>;
  signInWithGoogle(request: Request, callbackURL: string): Promise<Response>;
}

/** Read a personal bearer token from one dashboard API request. */
export function dashboardPersonalBearerToken(
  request: Request,
): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  return /^Bearer ([^\s]+)$/.exec(authorization)?.[1];
}

/** Adapt a verified personal-token email to dashboard session policy. */
export function dashboardBearerSession(email: string): DashboardSession {
  return { user: { email, emailVerified: true } };
}

/** Check the dashboard allowlist against one verified session. */
export function dashboardSessionIsAuthorized(
  session: DashboardSession,
  allowedDomains: string[],
  allowedEmails: string[],
): boolean {
  const email = session.user.email.toLowerCase();
  const separator = email.lastIndexOf("@");
  const domain = separator > 0 ? email.slice(separator + 1) : undefined;
  return Boolean(
    session.user.emailVerified &&
    (allowedEmails.includes(email) ||
      (domain !== undefined && allowedDomains.includes(domain))),
  );
}

/** Read a normalized email only from a verified dashboard session. */
export function verifiedDashboardSessionEmail(
  session: DashboardSession,
): string | undefined {
  if (session.user.emailVerified !== true) return undefined;
  const email = session.user.email.trim().toLowerCase();
  return email || undefined;
}

/** Keep dashboard identity responses limited to user display fields. */
export function sanitizeDashboardSession(
  session: DashboardSession,
): DashboardSession {
  const { email, emailVerified, name } = session.user;
  return dashboardSessionSchema.parse({
    user: {
      email,
      emailVerified,
      name,
    },
  });
}
