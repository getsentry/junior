/**
 * Sentry OAuth account.
 *
 * Sentry returns the authorized user in the OAuth token response. The Sentry
 * users API rejects OAuth app tokens, so Junior reads the account from that
 * response.
 */
import type {
  PluginProviderAccount,
  ResolveOAuthAccountHookContext,
} from "@sentry/junior-plugin-api";

function nonBlankString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Read the Sentry user from the OAuth token response.
 *
 * Sentry does not report whether the user email is verified, so the email is
 * only a label and never links the account.
 */
export function resolveSentryOAuthAccount(
  ctx: ResolveOAuthAccountHookContext,
): PluginProviderAccount | undefined {
  const user = ctx.tokenResponse.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    return undefined;
  }
  const fields = user as Record<string, unknown>;
  const id = nonBlankString(fields.id);
  if (!id) {
    return undefined;
  }
  const name = nonBlankString(fields.name);
  const label = nonBlankString(fields.email) ?? name;
  return {
    id,
    ...(name ? { displayName: name } : undefined),
    ...(label ? { label } : undefined),
  };
}
