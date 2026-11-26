/**
 * Read the domain list that may use Junior. Slack authors must have a Slack
 * profile email on one of them, and dashboard Google sign-ins must come from
 * a Google Workspace account whose `hd` claim is one of them. Slack and the
 * dashboard share one list. `chat/identities/trust` decides who matches.
 */
import * as z from "zod";
import { getChatConfig } from "@/chat/config";

/** Parse a list env var value: a JSON string array or comma-separated values. */
export function parseEnvList(
  name: string,
  rawValue: string | undefined,
): string[] | undefined {
  const value = rawValue?.trim();
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
      (
        allowedDomains ??
        parseEnvList(
          "JUNIOR_ALLOWED_DOMAINS",
          getChatConfig().signIn.allowedDomains,
        ) ??
        []
      )
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * Fail startup on the removed Google-specific option. Ignoring it would
 * leave the list empty, which lets every Slack workspace member in.
 * `loadConfig` rejects the removed env var the same way.
 */
export function assertNoLegacyAllowedDomains(
  dashboardOptionKeys: readonly string[],
) {
  if (dashboardOptionKeys.includes("allowedGoogleDomains")) {
    throw new Error(
      "dashboard.allowedGoogleDomains was removed; set createApp({ allowedDomains }) instead",
    );
  }
}
