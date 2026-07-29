import type { PluginLogger } from "@sentry/junior-plugin-api";
import { logException, logInfo, logWarn } from "@/chat/logging";

/** Create the host logger exposed to plugin hooks. */
export function createPluginLogger(plugin: string): PluginLogger {
  return {
    info(message, metadata) {
      logInfo("plugin.log.info", {
        "app.log.message": message,
        "app.plugin.name": plugin,
        ...metadata,
      });
    },
    warn(message, metadata) {
      logWarn("plugin.log.warn", {
        "app.log.message": message,
        "app.plugin.name": plugin,
        ...metadata,
      });
    },
    error(message, metadata) {
      logException(new Error(message), "plugin.log.error", {
        "app.plugin.name": plugin,
        ...metadata,
      });
    },
  };
}
