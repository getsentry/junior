/** Virtual module injected by juniorNitro() at build time. */
declare module "#junior/config" {
  import type { PluginCatalogConfig } from "@/chat/plugins/types";
  import type { JuniorDashboardOptions } from "@/app";
  import type { JuniorPluginSet } from "@/plugins";
  import type { PluginRouteApp } from "@sentry/junior-plugin-api";

  type VirtualDashboardConfig = JuniorDashboardOptions;

  interface VirtualDashboardOptions extends VirtualDashboardConfig {
    pluginRoutes?: Array<{
      app: PluginRouteApp;
      pluginName: string;
    }>;
  }

  export const createDashboardApp:
    | ((options: VirtualDashboardOptions) => {
        fetch(request: Request): Promise<Response> | Response;
      })
    | undefined;
  export const dashboard: VirtualDashboardConfig | undefined;
  export const pluginSet: JuniorPluginSet | undefined;
  export const plugins: PluginCatalogConfig;
  export const pluginRuntimeRegistrations: string[];
}
