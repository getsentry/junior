import type { GitHubAppCredentials, OAuthBearerCredentials } from "../types";

const DEFAULT_PLACEHOLDERS: Record<
  OAuthBearerCredentials["type"] | GitHubAppCredentials["type"],
  string
> = {
  "oauth-bearer": "host_managed_credential",
  "github-app": "ghp_host_managed_credential",
};

/** Resolve the non-secret sandbox token placeholder for token-backed credentials. */
export function resolveAuthTokenPlaceholder(
  credentials: OAuthBearerCredentials | GitHubAppCredentials,
): string {
  return (
    credentials.authTokenPlaceholder?.trim() ||
    DEFAULT_PLACEHOLDERS[credentials.type]
  );
}
