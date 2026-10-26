/**
 * Domains that may use Junior. Slack authors must have a Slack profile email
 * on one of them, and dashboard Google sign-ins must come from a Google
 * Workspace account whose `hd` claim is one of them. Slack and the dashboard
 * share one list.
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
 * Resolve the allowed domains: the `createApp` option when set, else
 * `JUNIOR_ALLOWED_DOMAINS`. An empty list allows every domain.
 */
export function resolveAllowedDomains(allowedDomains?: string[]): string[] {
  return [
    ...new Set(
      (allowedDomains ?? readEnvList("JUNIOR_ALLOWED_DOMAINS") ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * Fail startup on the removed Google-specific names. Ignoring them would
 * leave the list empty, which lets every Slack workspace member in.
 */
export function assertNoLegacyAllowedDomains(
  dashboardOptionKeys: readonly string[],
) {
  if (dashboardOptionKeys.includes("allowedGoogleDomains")) {
    throw new Error(
      "dashboard.allowedGoogleDomains was removed; set createApp({ allowedDomains }) instead",
    );
  }
  if (process.env.JUNIOR_DASHBOARD_GOOGLE_DOMAINS?.trim()) {
    throw new Error(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS was removed; set JUNIOR_ALLOWED_DOMAINS instead",
    );
  }
}

/** Return whether a verified domain may use Junior. An empty list allows all. */
export function isAllowedDomain(
  domain: string | undefined,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  return Boolean(domain && allowedDomains.includes(domain.toLowerCase()));
}
