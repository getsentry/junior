import type { Nitro } from "nitro/types";

/** Inject a virtual module so createApp() can read the plugin list at runtime. */
export function injectVirtualConfig(
  nitro: Nitro,
  pluginPackages: string[],
): void {
  nitro.options.virtual["#junior/config"] =
    `export const pluginPackages = ${JSON.stringify(pluginPackages)};`;
}
