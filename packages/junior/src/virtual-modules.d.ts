/** Virtual module injected by juniorNitro() at build time. */
declare module "#junior/config" {
  import type { PluginCatalogConfig } from "@/chat/plugins/types";
  import type { JuniorPluginSet } from "@/plugins";

  export const pluginSet: JuniorPluginSet | undefined;
  export const plugins: PluginCatalogConfig;
  export const pluginHookRegistrations: string[];
}
