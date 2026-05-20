/** Virtual module injected by juniorNitro() at build time. */
declare module "#junior/config" {
  import type { PluginConfig } from "@/chat/plugins/types";

  export const plugins: PluginConfig;
}
