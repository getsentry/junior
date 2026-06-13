import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";
import type { PluginDb } from "@sentry/junior-plugin-api";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import type { JuniorPluginSet } from "@/plugins";

export interface UpgradeIo {
  info: (line: string) => void;
}

export interface MigrationContext {
  io: UpgradeIo;
  pluginDb?: PluginDb;
  pluginCatalogConfig?: PluginCatalogConfig;
  pluginSet?: JuniorPluginSet;
  sqlDatabaseUrl?: string;
  redisStateAdapter?: RedisStateAdapter;
  stateAdapter: StateAdapter;
}

export interface MigrationResult {
  existing: number;
  migrated: number;
  missing: number;
  scanned: number;
  skipped?: number;
}

export interface UpgradeMigration {
  name: string;
  run(context: MigrationContext): Promise<MigrationResult>;
}
