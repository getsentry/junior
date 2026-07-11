import type { Nitro } from "nitro/types";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import type { JuniorDashboardOptions } from "@/app";
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

function renderDashboardImport(enabled: boolean): string[] {
  return enabled
    ? [
        'import { createDashboardApp as juniorCreateDashboardApp } from "@sentry/junior-dashboard";',
        "export const createDashboardApp = juniorCreateDashboardApp;",
      ]
    : ["export const createDashboardApp = undefined;"];
}

function dashboardEnabled(
  dashboard: JuniorDashboardOptions | undefined,
): boolean {
  return Boolean(dashboard && !dashboard.disabled);
}

/** Render the virtual config module consumed by createApp(). */
export function renderVirtualConfig(options: {
  dashboard?: JuniorDashboardOptions;
  plugins?: PluginCatalogConfig;
  pluginModule?: RuntimePluginModule;
  pluginRuntimeRegistrations?: string[];
}): string {
  const lines = [
    ...renderDashboardImport(dashboardEnabled(options.dashboard)),
    ...(options.pluginModule
      ? [
          renderRuntimePluginImport(options.pluginModule),
          "export const pluginSet = juniorRuntimePluginSet;",
        ]
      : ["export const pluginSet = undefined;"]),
    `export const plugins = ${JSON.stringify(options.plugins ?? { packages: [] })};`,
    `export const pluginRuntimeRegistrations = ${JSON.stringify(options.pluginRuntimeRegistrations ?? [])};`,
    `export const dashboard = ${JSON.stringify(options.dashboard)};`,
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
    dashboard?: JuniorDashboardOptions;
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
      dashboard: options.dashboard,
    });
  };
}
