import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { createMemoryRegistration, type MemoryOptions } from "./registration";

const LEGACY_MEMORY_PACKAGE = "@sentry/junior-memory";
type LegacyMemoryRegistration = PluginRegistration & {
  coreMemoryOptions?: MemoryOptions;
};

/** Return options carried by the deprecated Memory registration. */
export function legacyMemoryOptions(
  plugins: readonly PluginRegistration[],
): MemoryOptions | undefined {
  const legacy = plugins.find(
    (plugin): plugin is LegacyMemoryRegistration =>
      plugin.manifest.name === "memory" &&
      plugin.packageName === LEGACY_MEMORY_PACKAGE,
  );
  return legacy?.coreMemoryOptions;
}

/** Return whether a registration is the deprecated Memory marker. */
export function isLegacyMemoryRegistration(
  plugin: PluginRegistration,
): boolean {
  return (
    plugin.manifest.name === "memory" &&
    plugin.packageName === LEGACY_MEMORY_PACKAGE
  );
}

/** Remove the deprecated marker and reject another Memory registration. */
export function installedRuntimeRegistrations(
  plugins: PluginRegistration[],
): PluginRegistration[] {
  return plugins.filter((plugin) => {
    if (plugin.manifest.name !== "memory") return true;
    if (isLegacyMemoryRegistration(plugin)) return false;
    throw new Error('Plugin registration name "memory" is reserved by core');
  });
}

/** Add core Memory to installed runtime registrations. */
export function memoryRuntimeRegistrations(
  plugins: PluginRegistration[],
  options: MemoryOptions = {},
): PluginRegistration[] {
  return [
    createMemoryRegistration(options),
    ...installedRuntimeRegistrations(plugins),
  ];
}
