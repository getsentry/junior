import type { PluginDatabaseConfig } from "./database";
import type { PluginHooks } from "./hooks";
import type { PluginManifest } from "./manifest";

export type PluginRegistrationInput = {
  database?: PluginDatabaseConfig;
  hooks?: PluginHooks;
  legacyStatePrefixes?: string[];
  manifest: PluginManifest;
  name?: string;
  packageName?: string;
};

export interface PluginRegistration extends PluginRegistrationInput {
  name: string;
}

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Define one Junior plugin registration for app and build-time wiring. */
export function defineJuniorPlugin(
  plugin: PluginRegistrationInput,
): PluginRegistration {
  if ("pluginConfig" in plugin) {
    throw new Error(
      "pluginConfig is no longer supported. Put runtime metadata in manifest and state prefixes on the plugin registration.",
    );
  }
  const manifest = plugin.manifest;
  if (!manifest) {
    throw new Error(
      "defineJuniorPlugin() requires a manifest. Use a package name string in defineJuniorPlugins([...]) for plugin.yaml packages.",
    );
  }
  const name = plugin.name ?? manifest.name;
  if (!name) {
    throw new Error(
      "Junior plugin registrations must include name or manifest.name.",
    );
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
  if (plugin.name && manifest.name && plugin.name !== manifest.name) {
    throw new Error(
      `Junior plugin registration name "${plugin.name}" must match manifest.name "${manifest.name}".`,
    );
  }
  return {
    ...plugin,
    name,
  };
}
