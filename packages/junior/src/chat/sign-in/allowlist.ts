/**
 * Domains that may use Junior. Google sign-ins must come from a Google
 * Workspace account on one of these domains, and Slack authors must have a
 * Slack profile email on one of them. The dashboard and Slack use one list.
 */
import { z } from "zod";

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
 * Resolve the allowed domains: the dashboard option when set, else its
 * environment variable. An empty list allows every domain.
 */
export function resolveAllowedDomains(
  options: { allowedGoogleDomains?: string[] } = {},
): string[] {
  return [
    ...new Set(
      (
        options.allowedGoogleDomains ??
        readEnvList("JUNIOR_DASHBOARD_GOOGLE_DOMAINS") ??
        []
      )
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Return whether a verified domain may use Junior. An empty list allows all. */
export function isAllowedDomain(
  domain: string | undefined,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  return Boolean(domain && allowedDomains.includes(domain.toLowerCase()));
}
