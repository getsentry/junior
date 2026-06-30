import type { PluginLogger } from "@sentry/junior-plugin-api";
import { logException, logInfo, logWarn } from "@/chat/logging";

/** Create the host logger exposed to plugin hooks. */
export function createPluginLogger(plugin: string): PluginLogger {
  return {
    info(message, metadata) {
      logInfo(
        "agent_plugin_log_info",
        {},
        { "app.plugin.name": plugin, ...metadata },
        message,
      );
    },
    warn(message, metadata) {
      logWarn(
        "agent_plugin_log_warn",
        {},
        { "app.plugin.name": plugin, ...metadata },
        message,
      );
    },
    error(message, metadata) {
      logException(
        new Error(message),
        "agent_plugin_log_error",
        {},
        { "app.plugin.name": plugin, ...metadata },
        message,
      );
    },
  };
}
