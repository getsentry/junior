/**
 * Deployment configuration for the Google plugin.
 *
 * Values come from host environment variables. They never reach the sandbox.
 */

export const GOOGLE_CLIENT_ID_ENV = "GOOGLE_WORKSPACE_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "GOOGLE_WORKSPACE_CLIENT_SECRET";
export const GOOGLE_ACCOUNT_EMAIL_ENV = "GOOGLE_WORKSPACE_ACCOUNT_EMAIL";
export const GOOGLE_ALLOWED_DOMAINS_ENV = "GOOGLE_WORKSPACE_ALLOWED_DOMAINS";

/** Scopes that Calendar v1 needs. Request nothing broader. */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;

/** Identity scopes used only to verify which account signed in. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;

export interface GoogleConfig {
  /** The Workspace account Junior acts as, for example `junior@sentry.io`. */
  accountEmail: string;
  /** Domains Junior may check availability for and invite. */
  allowedDomains: string[];
  clientId: string;
  clientSecret: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readList(name: string): string[] {
  return (readEnv(name) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Return the email domain in lowercase, or undefined for a malformed email. */
export function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return undefined;
  }
  return email.slice(at + 1).toLowerCase();
}

/**
 * Read the Google plugin configuration, or undefined when the deployment does
 * not configure the plugin.
 */
export function readGoogleConfig(): GoogleConfig | undefined {
  const clientId = readEnv(GOOGLE_CLIENT_ID_ENV);
  const clientSecret = readEnv(GOOGLE_CLIENT_SECRET_ENV);
  const accountEmail = readEnv(GOOGLE_ACCOUNT_EMAIL_ENV)?.toLowerCase();
  if (!clientId || !clientSecret || !accountEmail) {
    return undefined;
  }
  const accountDomain = emailDomain(accountEmail);
  if (!accountDomain) {
    throw new Error(`${GOOGLE_ACCOUNT_EMAIL_ENV} must be an email address`);
  }
  const allowedDomains = readList(GOOGLE_ALLOWED_DOMAINS_ENV);
  return {
    accountEmail,
    allowedDomains: allowedDomains.length ? allowedDomains : [accountDomain],
    clientId,
    clientSecret,
  };
}
