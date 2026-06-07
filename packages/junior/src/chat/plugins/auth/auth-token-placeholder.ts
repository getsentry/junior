import type {
  OAuthBearerCredentials,
  PluginManagedCredentials,
} from "../types";

const DEFAULT_PLACEHOLDERS: Record<
  OAuthBearerCredentials["type"] | PluginManagedCredentials["type"],
  string
> = {
  "oauth-bearer": "host_managed_credential",
  "plugin-managed": "host_managed_credential",
};

/** Resolve the non-secret sandbox token placeholder for token-backed credentials. */
export function resolveAuthTokenPlaceholder(
  credentials: OAuthBearerCredentials | PluginManagedCredentials,
): string {
  return (
    credentials.authTokenPlaceholder?.trim() ||
    DEFAULT_PLACEHOLDERS[credentials.type]
  );
}
