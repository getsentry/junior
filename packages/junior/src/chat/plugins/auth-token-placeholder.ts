import type { PluginCredentials } from "./types";

const DEFAULT_PLACEHOLDERS: Record<PluginCredentials["type"], string> = {
  "oauth-bearer": "host_managed_credential",
  "github-app": "ghp_host_managed_credential"
};

export function resolveAuthTokenPlaceholder(credentials: PluginCredentials): string {
  return credentials.authTokenPlaceholder?.trim() || DEFAULT_PLACEHOLDERS[credentials.type];
}
