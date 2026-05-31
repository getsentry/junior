import type { Nitro } from "nitro/types";
import type { PluginCatalogConfig } from "@/chat/plugins/types";

/** Inject a virtual module so createApp() can read the plugin list at runtime. */
export function injectVirtualConfig(
  nitro: Nitro,
  options: {
    plugins?: PluginCatalogConfig;
    trustedPluginRegistrations?: string[];
  } = {},
): void {
  nitro.options.virtual["#junior/config"] = [
    `export const plugins = ${JSON.stringify(options.plugins ?? { packages: [] })};`,
    `export const trustedPluginRegistrations = ${JSON.stringify(options.trustedPluginRegistrations ?? [])};`,
  ].join("\n");
}
