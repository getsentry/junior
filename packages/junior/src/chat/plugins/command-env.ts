import type { PluginManifest } from "@/chat/plugins/types";

const ENV_PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function resolveValue(
  manifest: PluginManifest,
  value: string,
): string | undefined {
  let missing = false;
  const resolved = value.replace(ENV_PLACEHOLDER_RE, (match, name) => {
    const envName = name as string;
    const declaration = manifest.envVars?.[envName];
    if (!declaration || declaration.default !== undefined) {
      return match;
    }
    const hostValue = process.env[envName];
    if (hostValue === undefined || hostValue === "") {
      missing = true;
      return "";
    }
    return hostValue;
  });
  return missing ? undefined : resolved;
}

/** Resolve sandbox command env declared by a plugin manifest. */
export function resolvePluginCommandEnv(
  manifest: PluginManifest,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.commandEnv ?? {})) {
    const resolved = resolveValue(manifest, value);
    if (resolved === undefined) {
      continue;
    }
    env[key] = resolved;
  }
  return env;
}
