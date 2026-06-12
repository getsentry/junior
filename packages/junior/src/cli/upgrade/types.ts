import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";

export interface UpgradeIo {
  info: (line: string) => void;
}

export interface MigrationContext {
  io: UpgradeIo;
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
