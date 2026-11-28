import {
  createAppContext,
  installAppContext,
  type AppContext,
} from "@/app/context";
import { resolveAppPaths } from "@/chat/discovery";
import { loadConfig, type ConfigInput } from "@/config";
import {
  pluginCatalogConfigFromEnv,
  pluginCatalogConfigFromPluginSet,
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "@/plugins";

/**
 * Run one CLI command with its own app context: config from `process.env`
 * and `config`, plugins from the app plugin set. Module getters read the
 * context while the command runs. The context closes when it ends.
 */
export async function withCliAppContext<T>(
  args: {
    config?: ConfigInput | undefined;
    pluginSet?: JuniorPluginSet | undefined;
  },
  run: (context: AppContext) => Promise<T>,
): Promise<T> {
  const context = createAppContext({
    config: loadConfig({ env: process.env, options: args.config }),
    env: process.env,
    paths: resolveAppPaths(),
    plugins: pluginRuntimeRegistrationsFromPluginSet(args.pluginSet),
    pluginConfig: args.pluginSet
      ? pluginCatalogConfigFromPluginSet(args.pluginSet)
      : pluginCatalogConfigFromEnv(),
  });
  const previous = installAppContext(context);
  try {
    return await run(context);
  } finally {
    installAppContext(previous);
    await context.close();
  }
}
