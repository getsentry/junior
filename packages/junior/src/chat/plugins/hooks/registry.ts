/** The registered app plugins, and their validation. */
import {
  pluginEventsSchema,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { getAppContext } from "@/app/context";
import {
  coreRegistrations,
  isCoreRegistrationName,
} from "@/chat/plugins/core-registrations";

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PLUGIN_TASK_NAME_RE = /^[a-z][A-Za-z0-9]*$/;

/** Validate plugin identity before it can affect process-wide hooks. */
export function validatePlugins(plugins: PluginRegistration[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    if (!PLUGIN_NAME_RE.test(name)) {
      throw new Error(
        `Plugin name "${name}" must be a lowercase plugin identifier`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate plugin name "${name}"`);
    }
    if (isCoreRegistrationName(name)) {
      throw new Error(`Plugin name "${name}" is reserved for a core feature`);
    }
    if (
      plugin.events !== undefined &&
      !pluginEventsSchema.safeParse(plugin.events).success
    ) {
      throw new Error(`Plugin "${name}" events is invalid`);
    }
    // `guardian.tools` is for remote tools with no definition in plugin code.
    const guardianTools = Object.keys(plugin.hooks?.guardian?.tools ?? {});
    const pluginTools =
      guardianTools.length > 0 ? (plugin.hooks?.tools?.() ?? {}) : {};
    for (const tool of guardianTools) {
      if (Object.hasOwn(pluginTools, tool)) {
        throw new Error(
          `Plugin "${name}" defines tool "${tool}" in code and in guardian.tools`,
        );
      }
    }
    for (const [taskName, task] of Object.entries(plugin.tasks ?? {})) {
      if (!PLUGIN_TASK_NAME_RE.test(taskName)) {
        throw new Error(
          `Plugin task "${taskName}" from plugin "${name}" must be a camelCase identifier`,
        );
      }
      if (typeof task.run !== "function") {
        throw new Error(
          `Plugin task "${taskName}" from plugin "${name}" must define a run function`,
        );
      }
      if (
        task.payload !== undefined &&
        typeof task.payload.safeParse !== "function"
      ) {
        throw new Error(
          `Plugin task "${taskName}" from plugin "${name}" must use a Zod schema for payload`,
        );
      }
    }
    seen.add(name);
  }
}

/**
 * The `guardian.tools` keys of a provider's plugin that match no tool its
 * MCP server lists. Such an entry never runs.
 */
export function unlistedGuardianTools(
  provider: string,
  listed: readonly string[],
): string[] {
  const names = new Set(listed);
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === provider,
  );
  return Object.keys(plugin?.hooks?.guardian?.tools ?? {}).filter(
    (tool) => !names.has(tool),
  );
}

/** Return the current runtime hook plugins without exposing mutable state. */
export function getPlugins(): PluginRegistration[] {
  return [...getAppContext().plugins];
}

/**
 * Return app plugins, then core feature registrations. Feature hook sites
 * read this list. Provider hooks, such as credentials and routes, read only
 * app plugins.
 */
export function getRegistrations(): PluginRegistration[] {
  return [...getAppContext().plugins, ...coreRegistrations()];
}
