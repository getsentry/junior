import type { Nitro } from "nitro/types";
import type { ChatPlatform } from "@/chat/platforms";
import type { JuniorPlatformOptionsMap } from "@/chat/platform-config";

export interface VirtualJuniorConfig {
  enabledPlatforms?: readonly ChatPlatform[];
  pluginPackages?: string[];
  platforms?: JuniorPlatformOptionsMap;
}

/** Inject a virtual module so createApp() can read build-time config at runtime. */
export function injectVirtualConfig(
  nitro: Nitro,
  config: VirtualJuniorConfig,
): void {
  nitro.options.virtual["#junior/config"] = [
    `export const pluginPackages = ${JSON.stringify(config.pluginPackages ?? [])};`,
    `export const enabledPlatforms = ${JSON.stringify(config.enabledPlatforms)};`,
    `export const platforms = ${JSON.stringify(config.platforms)};`,
  ].join("\n");
}
