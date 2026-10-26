/** Google accounts that may sign in. The dashboard uses the same list. */
import { z } from "zod";

/** Google accounts that may sign in. Empty lists allow nobody. */
export interface SignInAllowlist {
  domains: string[];
  emails: string[];
}

/**
 * Read a list env var the same way as the dashboard: a JSON string array or
 * comma-separated values.
 */
export function readEnvList(name: string): string[] | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!value.startsWith("[")) return value.split(",");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON string array`, { cause: error });
  }
  const list = z.array(z.string()).safeParse(parsed);
  if (!list.success) throw new Error(`${name} must be a JSON string array`);
  return list.data;
}

/**
 * Resolve the sign-in allowlist. Use the same values as the dashboard: its
 * options when set, else its environment variables.
 */
export function resolveSignInAllowlist(
  options: { allowedEmails?: string[]; allowedGoogleDomains?: string[] } = {},
): SignInAllowlist {
  const list = (values: string[] | undefined, name: string) =>
    (values ?? readEnvList(name) ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  return {
    domains: list(
      options.allowedGoogleDomains,
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS",
    ),
    emails: list(options.allowedEmails, "JUNIOR_DASHBOARD_ALLOWED_EMAILS"),
  };
}

/** Return whether a normalized Google email is on the allowlist. */
export function isSignInAllowed(
  email: string,
  allowlist: SignInAllowlist,
): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return allowlist.emails.includes(email) || allowlist.domains.includes(domain);
}
