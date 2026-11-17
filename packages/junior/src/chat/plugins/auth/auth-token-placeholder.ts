import type { OAuthBearerCredentials } from "../types";

/**
 * The marker that every built-in Sandbox credential placeholder contains,
 * such as `host_managed_credential` or `ghp_host_managed_credential`.
 */
export const HOST_MANAGED_CREDENTIAL_PLACEHOLDER = "host_managed_credential";

/** Resolve the non-secret sandbox token placeholder for token-backed credentials. */
export function resolveAuthTokenPlaceholder(
  credentials: OAuthBearerCredentials,
): string {
  return (
    credentials.authTokenPlaceholder?.trim() ||
    HOST_MANAGED_CREDENTIAL_PLACEHOLDER
  );
}
