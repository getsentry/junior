import type { Nitro } from "nitro/types";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import {
  pluginCatalogConfigFromPluginSet,
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "@/plugins";

export interface RuntimePluginModule {
  exportName: string;
  specifier: string;
}

function renderRuntimePluginImport(module: RuntimePluginModule): string {
  if (module.exportName === "default") {
    return `import juniorRuntimePluginSet from ${JSON.stringify(module.specifier)};`;
  }

  return `import { ${module.exportName} as juniorRuntimePluginSet } from ${JSON.stringify(module.specifier)};`;
}

/** Render the virtual config module consumed by createApp(). */
export function renderVirtualConfig(options: {
  plugins?: PluginCatalogConfig;
  pluginModule?: RuntimePluginModule;
  pluginRuntimeRegistrations?: string[];
}): string {
  const lines = [
    ...(options.pluginModule
      ? [
          renderRuntimePluginImport(options.pluginModule),
          "export const pluginSet = juniorRuntimePluginSet;",
        ]
      : ["export const pluginSet = undefined;"]),
    `export const plugins = ${JSON.stringify(options.plugins ?? { packages: [] })};`,
    `export const pluginRuntimeRegistrations = ${JSON.stringify(options.pluginRuntimeRegistrations ?? [])};`,
  ];

  return lines.join("\n");
}

/** Inject a virtual module so createApp() can read the plugin list at runtime. */
export function injectVirtualConfig(
  nitro: Nitro,
  options: {
    loadPluginSet?: () => Promise<JuniorPluginSet | undefined>;
    pluginModule?: RuntimePluginModule;
    plugins?: PluginCatalogConfig;
    pluginRuntimeRegistrations?: string[];
  } = {},
): void {
  nitro.options.virtual["#junior/config"] = async () => {
    if (!options.loadPluginSet) {
      return renderVirtualConfig(options);
    }

    const pluginSet = await options.loadPluginSet();

    return renderVirtualConfig({
      pluginModule: options.pluginModule,
      plugins: pluginCatalogConfigFromPluginSet(pluginSet),
      pluginRuntimeRegistrations: pluginRuntimeRegistrationsFromPluginSet(
        pluginSet,
      ).map((plugin) => plugin.manifest.name),
    });
  };
}
