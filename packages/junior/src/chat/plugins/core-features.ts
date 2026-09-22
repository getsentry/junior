/**
 * Core feature registrations.
 *
 * A core feature uses the same runtime registration contract as a plugin so
 * the host serves its tools, prompt context, tasks, events, user pages, API
 * routes, CLI commands, and operational reports through one path. Core
 * features never enter plugin or package discovery, and no plugin can claim a
 * core feature name.
 */
import type { PluginRegistration } from "@sentry/junior-plugin-api";

/** Registration names that core features own. */
export const CORE_FEATURE_NAMES: ReadonlySet<string> = new Set([
  "briefs",
  "memory",
]);

let registeredCoreFeatures: PluginRegistration[] = [];

/** Return whether a registration name belongs to a core feature. */
export function isCoreFeatureName(name: string): boolean {
  return CORE_FEATURE_NAMES.has(name);
}

/** Replace the installed core features and return the previous list for rollback. */
export function setCoreFeatures(
  features: PluginRegistration[],
): PluginRegistration[] {
  const seen = new Set<string>();
  for (const feature of features) {
    const name = feature.manifest.name;
    if (!isCoreFeatureName(name)) {
      throw new Error(`Core feature name "${name}" is not reserved for core`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate core feature "${name}"`);
    }
    seen.add(name);
  }
  const previous = registeredCoreFeatures;
  registeredCoreFeatures = [...features];
  return previous;
}

/** Return the installed core features without exposing mutable state. */
export function getCoreFeatures(): PluginRegistration[] {
  return [...registeredCoreFeatures];
}
