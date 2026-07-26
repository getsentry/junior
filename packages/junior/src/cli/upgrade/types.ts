import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import type { JuniorPluginSet } from "@/plugins";

export interface UpgradeIo {
  info: (line: string) => void;
}

export interface MigrationStateContext {
  redisStateAdapter?: RedisStateAdapter;
  stateAdapter: StateAdapter;
}

export interface MigrationContext {
  getStateContext: () => Promise<MigrationStateContext>;
  io: UpgradeIo;
  pluginCatalogConfig?: PluginCatalogConfig;
  pluginSet?: JuniorPluginSet;
}

export type MigrationResult = {
  existing: number;
  migrated: number;
  missing: number;
  scanned: number;
  skipped?: number;
};
