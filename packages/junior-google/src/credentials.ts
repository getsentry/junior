/**
 * Credential issuing and egress policy for Google APIs.
 *
 * Only this plugin's own tools may use Junior's Google account. The tools
 * enforce disclosure and invite rules in code, so the sandbox and other
 * callers get no Google credential at all.
 */
import {
  EgressPolicyDenied,
  type EgressHookContext,
  type IssueCredentialHookContext,
  type PluginCredentialResult,
  type PluginGrant,
} from "@sentry/junior-plugin-api";
import { readGoogleConfig } from "./config";
import { refreshGoogleAccessToken } from "./oauth";
import { GOOGLE_PLUGIN_ROUTE_PREFIX } from "./setup-routes";
import {
  deleteRejectedGoogleAccount,
  getGoogleAccount,
  type GoogleDb,
} from "./store";

export const GOOGLE_API_DOMAIN = "www.googleapis.com";
const GRANT_NAME = "account";
// Renew leases a little before Google's access token expires.
const LEASE_SAFETY_MS = 60_000;

/** Google API operations that plugin tools may perform. */
export const GOOGLE_OPERATIONS = {
  "google.calendar.event.create": {
    access: "write",
    method: "POST",
    path: /^\/calendar\/v3\/calendars\/primary\/events$/,
  },
  "google.calendar.event.get": {
    access: "read",
    method: "GET",
    path: /^\/calendar\/v3\/calendars\/primary\/events\/[a-v0-9]+$/,
  },
  "google.calendar.freebusy.query": {
    access: "read",
    method: "POST",
    path: /^\/calendar\/v3\/freeBusy$/,
  },
} as const satisfies Record<
  string,
  { access: "read" | "write"; method: string; path: RegExp }
>;

export type GoogleOperation = keyof typeof GOOGLE_OPERATIONS;

/** Select the grant for one Google request, or deny it. */
export function googleGrantForEgress(ctx: EgressHookContext): PluginGrant {
  const operation = ctx.request.operation as GoogleOperation | undefined;
  const rule = operation ? GOOGLE_OPERATIONS[operation] : undefined;
  if (!rule) {
    // Sandbox commands carry no operation. Deny them so the account can only
    // be used through tools that apply Junior's disclosure rules.
    throw new EgressPolicyDenied(
      "Google APIs are only available through Junior's Google tools.",
    );
  }
  const url = new URL(ctx.request.url);
  if (
    url.hostname !== GOOGLE_API_DOMAIN ||
    ctx.request.method.toUpperCase() !== rule.method ||
    !rule.path.test(url.pathname)
  ) {
    throw new EgressPolicyDenied(
      `Google request does not match operation ${operation}.`,
    );
  }
  return {
    access: rule.access,
    name: GRANT_NAME,
    reason: `Use Junior's Google account for ${operation}`,
  };
}

function unavailable(message: string): PluginCredentialResult {
  return { type: "unavailable", message };
}

const NOT_CONNECTED_MESSAGE = `Junior's Google account is not connected. An admin must connect it at ${GOOGLE_PLUGIN_ROUTE_PREFIX}/setup on the Junior dashboard or with \`junior google connect\`.`;

/** Mint a short-lived access token for Junior's Google account. */
export async function issueGoogleCredential(
  ctx: IssueCredentialHookContext,
): Promise<PluginCredentialResult> {
  if (ctx.grant.name !== GRANT_NAME) {
    throw new Error(
      `Google plugin cannot issue unknown grant "${ctx.grant.name}".`,
    );
  }
  const config = readGoogleConfig();
  if (!config) {
    return unavailable(
      "The Google plugin is not configured on this deployment.",
    );
  }
  const db = ctx.db as GoogleDb;
  const record = await getGoogleAccount(db, config.accountEmail);
  if (!record) {
    return unavailable(NOT_CONNECTED_MESSAGE);
  }
  const token = await refreshGoogleAccessToken({
    config,
    refreshToken: record.refreshToken,
  });
  if (!token) {
    await deleteRejectedGoogleAccount(db, record);
    ctx.log.warn("google.account.token_rejected", {
      "app.google.account": config.accountEmail,
    });
    return unavailable(
      `Google revoked Junior's access. ${NOT_CONNECTED_MESSAGE}`,
    );
  }
  return {
    type: "lease",
    lease: {
      account: { id: config.accountEmail, label: config.accountEmail },
      expiresAt: new Date(token.expiresAtMs - LEASE_SAFETY_MS).toISOString(),
      headerTransforms: [
        {
          domain: GOOGLE_API_DOMAIN,
          headers: { Authorization: `Bearer ${token.accessToken}` },
        },
      ],
    },
  };
}
