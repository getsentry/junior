import type { PluginCliDefinition } from "./cli";
import type { PluginHooks } from "./hooks";
import type { PluginManifest } from "./manifest";
import type { PluginTasks } from "./tasks";
import type { PluginUserPageDefinition } from "./user-pages";

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
  userPages?: PluginUserPageDefinition[];
};

export interface PluginRegistration extends PluginRegistrationInput {}

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const USER_PAGE_ID_RE = /^[a-z][a-z0-9-]*$/;

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
  if (plugin.userPages !== undefined && !Array.isArray(plugin.userPages)) {
    throw new Error(`Junior plugin "${name}" userPages must be an array.`);
  }
  const userPageIds = new Set<string>();
  for (const page of plugin.userPages ?? []) {
    if (!page || typeof page !== "object") {
      throw new Error(`Junior plugin "${name}" user pages must be objects.`);
    }
    if (
      typeof page.id !== "string" ||
      page.id.length > 64 ||
      !USER_PAGE_ID_RE.test(page.id)
    ) {
      throw new Error(
        `Junior plugin "${name}" user page id "${page.id}" must be a lowercase identifier.`,
      );
    }
    if (userPageIds.has(page.id)) {
      throw new Error(
        `Junior plugin "${name}" has duplicate user page id "${page.id}".`,
      );
    }
    if (
      typeof page.label !== "string" ||
      !page.label.trim() ||
      page.label.length > 80 ||
      typeof page.description !== "string" ||
      !page.description.trim() ||
      page.description.length > 500
    ) {
      throw new Error(
        `Junior plugin "${name}" user page "${page.id}" requires label and description.`,
      );
    }
    if (typeof page.read !== "function") {
      throw new Error(
        `Junior plugin "${name}" user page "${page.id}" requires a read function.`,
      );
    }
    userPageIds.add(page.id);
  }
  return {
    ...plugin,
  };
}
