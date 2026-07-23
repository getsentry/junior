import type { PluginCatalogConfig } from "@/chat/plugins/types";
import type { JuniorSqlExecutor } from "@/db/db";
import type { JuniorPluginSet } from "@/plugins";

export interface UpgradeIo {
  info: (line: string) => void;
}

export interface UpgradeContext {
  pluginCatalogConfig?: PluginCatalogConfig;
  pluginSet?: JuniorPluginSet;
  sqlExecutor: JuniorSqlExecutor;
}

export interface MigrationSummary {
  existing: number;
  migrated: number;
  scanned: number;
}
