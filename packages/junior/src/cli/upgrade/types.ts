import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import type { JuniorPluginSet } from "@/plugins";

export interface UpgradeIo {
  info: (line: string) => void;
}

export interface MigrationContext {
  io: UpgradeIo;
  pluginCatalogConfig?: PluginCatalogConfig;
  pluginSet?: JuniorPluginSet;
  redisStateAdapter?: RedisStateAdapter;
  stateAdapter: StateAdapter;
}

export type MigrationResult = {
  existing: number;
  migrated: number;
  missing: number;
  scanned: number;
  skipped?: number;
};
