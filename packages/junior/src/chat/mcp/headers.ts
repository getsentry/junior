/**
 * Runtime values for plugin MCP request headers.
 *
 * Manifests keep `${NAME}` placeholders so build output never holds the secret.
 * The manifest parser has already checked that each name is declared in
 * `env-vars` without a default, so resolution only reads the deployment env.
 */
import type { PluginMcpConfig } from "@sentry/junior-plugin-api";

const ENV_PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** Resolve `${NAME}` placeholders in MCP headers from the deployment env at connect time. */
export function resolveMcpHeaders(
  provider: string,
  headers: PluginMcpConfig["headers"],
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      value.replace(ENV_PLACEHOLDER_RE, (_match, name: string) => {
        const envValue = process.env[name]?.trim();
        if (!envValue) {
          throw new Error(
            `Missing ${name} for MCP header provider "${provider}"`,
          );
        }
        return envValue;
      }),
    ]),
  );
}
