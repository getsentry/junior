/**
 * Service account policy.
 *
 * A plugin can declare an optional install-wide provider account, often a
 * bot, that Junior itself uses. The credential order for one request is:
 *
 * 1. The Actor's own connection, when it exists.
 * 2. The plugin's service account, when an Admin connected it and this
 *    policy allows the request.
 * 3. Otherwise, the Actor must connect their own account.
 *
 * The service account usually has fewer permissions than a person. This
 * module is the one place that decides which requests it may serve. Each
 * request surface asks it before it uses the shared account. Surfaces that
 * Junior proxies, such as sandbox egress, can also enforce the policy on
 * each request.
 */
import type { PluginManifest } from "@/chat/plugins/types";

/** One request that a plugin's service account could serve. */
export interface ServiceAccountRequest {
  /** Provider MCP tool that the request calls. */
  mcpTool: string;
}

/** Return whether the plugin's service account policy allows this request. */
export function serviceAccountAllows(
  manifest: Pick<PluginManifest, "serviceAccount">,
  request: ServiceAccountRequest,
): boolean {
  return manifest.serviceAccount?.mcpTools.includes(request.mcpTool) ?? false;
}
