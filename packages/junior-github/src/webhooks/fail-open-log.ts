/**
 * Logging for optional webhook work that fails open.
 */
import type { PluginLogger } from "@sentry/junior-plugin-api";
import { GitHubRequestError } from "../credential-support.js";

/**
 * Log a failure of optional webhook work. A GitHub 5xx is a GitHub outage,
 * not a Junior bug, so it is a warning with the HTTP status. Other failures
 * stay errors.
 */
export function logFailOpenFailure(
  log: Pick<PluginLogger, "error" | "warn"> | undefined,
  message: string,
  error: unknown,
  metadata: Record<string, unknown>,
): void {
  const attributes = {
    ...metadata,
    errorType: error instanceof Error ? error.name : "UnknownError",
  };
  if (error instanceof GitHubRequestError && error.status >= 500) {
    log?.warn(message, {
      ...attributes,
      "http.response.status_code": error.status,
    });
    return;
  }
  log?.error(message, attributes);
}
