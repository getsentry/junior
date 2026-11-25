/**
 * Deployment configuration for the Google plugin.
 *
 * Values come from host environment variables. They never reach the sandbox.
 */

/** Dashboard sign-in uses the same OAuth client. */
export const GOOGLE_CLIENT_ID_ENV = "GOOGLE_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "GOOGLE_CLIENT_SECRET";
export const GOOGLE_ACCOUNT_EMAIL_ENV = "GOOGLE_WORKSPACE_ACCOUNT_EMAIL";
export const GOOGLE_ALLOWED_DOMAINS_ENV = "GOOGLE_WORKSPACE_ALLOWED_DOMAINS";
/** Set to `true` to read requests that people email to the bot's account. */
export const GOOGLE_EMAIL_REQUESTS_ENV = "GOOGLE_WORKSPACE_EMAIL_REQUESTS";

/**
 * API scopes the tools need. A connected grant must have all of them. Request
 * nothing broader.
 *
 * - `calendar.events.freebusy`: availability for `findMeetingTimes`.
 * - `calendar.events.readonly`: events that Junior's account can see on other
 *   people's calendars, for `listCalendarEvents`. Google sharing settings
 *   still decide how much detail each calendar shows.
 * - `calendar.events.owned`: create and change events on Junior's own
 *   calendar.
 * - `documents`: create Docs and edit Docs that Junior's account can already
 *   edit, through the Docs API. It gives no access to other Drive files and
 *   cannot change sharing.
 * - `drive.file`: make the requester the owner of a Doc or presentation that
 *   Junior created, then remove Junior's own access to a Doc. It only covers
 *   files this OAuth client created, so it cannot change sharing on other
 *   files. Full `drive` is not needed.
 * - `drive.readonly`: search Drive, export Docs, read Sheets and Slides, and
 *   read comments. The Drive comments API accepts no narrower read scope. The
 *   Sheets and Slides APIs also accept this scope.
 * - `presentations`: create presentations and edit Slides that Junior's
 *   account can already edit, through the Slides API. Like `documents`, it
 *   cannot change sharing.
 */
export const GOOGLE_API_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/presentations",
] as const;

/**
 * Read mail in the bot's inbox, for email requests only. Gmail has no
 * narrower scope that includes message bodies. Only the heartbeat uses it:
 * no Google operation allows a Gmail path, so no tool or sandbox command can
 * read mail.
 */
export const GOOGLE_GMAIL_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";

/** Identity scopes used only to verify which account signed in. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;

export interface GoogleConfig {
  /** The Workspace account Junior acts as, for example `junior@sentry.io`. */
  accountEmail: string;
  /** Domains Junior may check availability for and invite. */
  allowedDomains: string[];
  clientId: string;
  clientSecret: string;
  /** Turn email from trusted people into requests. */
  emailRequests: boolean;
}

/** Return every API scope that a connected grant of this deployment needs. */
export function googleApiScopes(config: GoogleConfig): string[] {
  return config.emailRequests
    ? [...GOOGLE_API_SCOPES, GOOGLE_GMAIL_SCOPE]
    : [...GOOGLE_API_SCOPES];
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
    emailRequests: readEnv(GOOGLE_EMAIL_REQUESTS_ENV) === "true",
  };
}
