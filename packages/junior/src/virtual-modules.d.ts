/** Virtual module injected by juniorNitro() at build time. */
declare module "#junior/config" {
  import type { PluginCatalogConfig } from "@/chat/plugins/types";

  export const plugins: PluginCatalogConfig;
  export const trustedPluginRegistrations: string[];
}
