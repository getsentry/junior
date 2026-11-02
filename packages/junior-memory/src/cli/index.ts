import type { PluginCliCommandDefinition } from "@sentry/junior-plugin-api";
import { configureMemoryReembedCommand } from "./reembed";
import { configureMemorySearchCommand } from "./search";
import { configureMemoryShowCommand } from "./show";

/** Create the plugin-owned memory admin CLI command. */
export function createMemoryCliCommand(): PluginCliCommandDefinition {
  return {
    name: "memory",
    summary: "Inspect and maintain Junior memory state",
    configure(command, junior) {
      configureMemorySearchCommand(command, junior);
      configureMemoryShowCommand(command, junior);
      configureMemoryReembedCommand(command, junior);
    },
  };
}
