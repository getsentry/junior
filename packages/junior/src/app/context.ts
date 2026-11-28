import type { PluginRegistration } from "@sentry/junior-plugin-api";
import type { AppContext, AppPaths } from "@/app/context-types";
import type { ChatConfig } from "@/chat/config";
import { createAppSql, createAppStores } from "@/chat/db";
import { validatePlugins } from "@/chat/plugins/hooks/registry";
import { createPluginCatalogRuntime } from "@/chat/plugins/registry";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import { createQueueProvider } from "@/chat/queue/provider";
import { createAppState } from "@/chat/state/adapter";
import type { Env } from "@/config/fields";

export type { AppContext, AppPaths } from "@/app/context-types";

/** What the composition root resolves before it builds the app context. */
export interface AppContextInput {
  config: ChatConfig;
  env: Env;
  paths: AppPaths;
  plugins?: PluginRegistration[] | undefined;
  pluginConfig?: PluginCatalogConfig | undefined;
}

/**
 * Build the app services from resolved config and plugin wiring. The SQL
 * pool and the state connection open on first use. `close()` releases them.
 */
export function createAppContext(input: AppContextInput): AppContext {
  const plugins = input.plugins ?? [];
  validatePlugins(plugins);
  const catalog = createPluginCatalogRuntime();
  // setConfig normalizes the config, as it did on the shared catalog.
  catalog.setConfig(input.pluginConfig);
  const sql = createAppSql(input.config.sql);
  const state = createAppState(input.config);
  return {
    config: input.config,
    env: input.env,
    paths: input.paths,
    sql,
    stores: createAppStores(sql),
    state,
    queue: createQueueProvider(input.config),
    plugins: [...plugins].sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name),
    ),
    catalog,
    clock: { now: () => Date.now() },
    slackTeamDomains: { entries: new Map(), inflight: new Map() },
    slackBotTeamIds: new Map(),
    slackUsers: new Map(),
    conversationTitles: new Map(),
    close: async () => {
      await Promise.all([state.close(), sql.close()]);
    },
  };
}

// Temporary bridge for module getters that cannot get the context passed in
// yet. getsentry/junior#4494 tracks deleting it.
let installed: AppContext | undefined;

/** Return the app context that the composition root installed. */
export function getAppContext(): AppContext {
  if (!installed) {
    throw new Error("No app context is installed");
  }
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
