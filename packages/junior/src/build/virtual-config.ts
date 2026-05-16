import type { Nitro } from "nitro/types";
import type { ChatPlatform } from "@/chat/platforms";

export interface VirtualJuniorConfig {
  enabledPlatforms?: readonly ChatPlatform[];
  pluginPackages?: string[];
}

/** Inject a virtual module so createApp() can read build-time config at runtime. */
export function injectVirtualConfig(
  nitro: Nitro,
  config: VirtualJuniorConfig,
): void {
  nitro.options.virtual["#junior/config"] = [
    `export const pluginPackages = ${JSON.stringify(config.pluginPackages ?? [])};`,
    `export const enabledPlatforms = ${JSON.stringify(config.enabledPlatforms)};`,
  ].join("\n");
}
