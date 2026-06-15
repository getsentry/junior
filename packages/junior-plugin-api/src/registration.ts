import type { PluginDatabaseConfig } from "./database";
import type { PluginHooks } from "./hooks";
import type { PluginManifest } from "./manifest";

export type PluginRegistrationInput = {
  database?: PluginDatabaseConfig;
  hooks?: PluginHooks;
  manifest: PluginManifest;
  packageName?: string;
};

export interface PluginRegistration extends PluginRegistrationInput {}

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Define one Junior plugin registration for app and build-time wiring. */
export function defineJuniorPlugin(
  plugin: PluginRegistrationInput,
): PluginRegistration {
  if ("pluginConfig" in plugin) {
    throw new Error(
      "pluginConfig is no longer supported. Put runtime metadata in manifest or plugin registration fields.",
    );
  }
  if ("name" in plugin) {
    throw new Error("defineJuniorPlugin() uses manifest.name for identity.");
  }
  const manifest = plugin.manifest;
  if (!manifest) {
    throw new Error(
      "defineJuniorPlugin() requires a manifest. Use a package name string in defineJuniorPlugins([...]) for plugin.yaml packages.",
    );
  }
  const name = manifest.name;
  if (!name) {
    throw new Error("Junior plugin manifest.name is required.");
  }
  if (!PLUGIN_NAME_RE.test(name)) {
    throw new Error(
      `Junior plugin registration name "${name}" must be a lowercase plugin identifier.`,
    );
  }
  if (
    typeof manifest.displayName !== "string" ||
    !manifest.displayName.trim()
  ) {
    throw new Error(
      `Junior plugin "${name}" manifest.displayName is required.`,
    );
  }
  if (
    typeof manifest.description !== "string" ||
    !manifest.description.trim()
  ) {
    throw new Error(
      `Junior plugin "${name}" manifest.description is required.`,
    );
  }
  return {
    ...plugin,
  };
}
