/** Virtual module injected by juniorNitro() at build time. */
declare module "#junior/config" {
  import type { PluginCatalogConfig } from "@/chat/plugins/types";
  import type { JuniorDashboardOptions } from "@/app";
  import type { JuniorPluginSet } from "@/plugins";

  type VirtualDashboardConfig = Omit<JuniorDashboardOptions, "reporting">;

  interface VirtualDashboardOptions extends VirtualDashboardConfig {
    pluginRoutes?: Array<{
      app: {
        fetch(request: Request): Promise<Response> | Response;
      };
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
