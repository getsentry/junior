import type { PluginCliDefinition } from "./cli";
import type { PluginHooks } from "./hooks";
import type { PluginManifest } from "./manifest";
import type { PluginTasks } from "./tasks";

export interface PluginModelConfig {
  /** Host model family used when no explicit structured model id is configured. */
  structuredModel?: "default" | "fast";
  /** Host model id used for this plugin's structured model calls. */
  structuredModelId?: string;
}

export type PluginRegistrationInput = {
  cli?: PluginCliDefinition;
  hooks?: PluginHooks;
  manifest: PluginManifest;
  model?: PluginModelConfig;
  packageName?: string;
  tasks?: PluginTasks;
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
