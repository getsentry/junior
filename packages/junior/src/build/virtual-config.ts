import type { Nitro } from "nitro/types";
import type { PluginConfig } from "@/chat/plugins/types";

/** Inject a virtual module so createApp() can read the plugin list at runtime. */
export function injectVirtualConfig(
  nitro: Nitro,
  plugins?: PluginConfig,
): void {
  nitro.options.virtual["#junior/config"] =
    `export const plugins = ${JSON.stringify(plugins ?? { packages: [] })};`;
}
