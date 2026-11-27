// The long-lived app state that `createApp` builds from its plugin wiring.
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { validatePlugins } from "@/chat/plugins/hooks/registry";
import {
  createPluginCatalogRuntime,
  type PluginCatalogRuntime,
} from "@/chat/plugins/registry";
import type { PluginCatalogConfig } from "@/chat/plugins/types";

export interface AppContext {
  /** App plugins, validated and sorted by manifest name. */
  plugins: PluginRegistration[];
  /** The plugin catalog, built from the app plugin config. */
  catalog: PluginCatalogRuntime;
}

/** Build the long-lived app state from resolved plugin wiring. */
export function createAppContext(
  input: {
    plugins?: PluginRegistration[] | undefined;
    pluginConfig?: PluginCatalogConfig | undefined;
  } = {},
): AppContext {
  const plugins = input.plugins ?? [];
  validatePlugins(plugins);
  const catalog = createPluginCatalogRuntime();
  // setConfig normalizes the config, as it did on the shared catalog.
  catalog.setConfig(input.pluginConfig);
  return {
    plugins: [...plugins].sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name),
    ),
    catalog,
  };
}

// Temporary bridge for code that cannot get the context passed in yet.
// getsentry/junior#4494 tracks deleting it.
let installed: AppContext | undefined;

/** Return the installed app context, or an empty one with no plugins. */
export function getAppContext(): AppContext {
  installed ??= createAppContext();
  return installed;
}

/** Install an app context and return the previous one for rollback. */
export function installAppContext(
  context: AppContext | undefined,
): AppContext | undefined {
  const previous = installed;
  installed = context;
  return previous;
}
