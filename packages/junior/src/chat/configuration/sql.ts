import { eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorChannelConfigurations } from "@/db/schema";
import {
  coerceChannelConfigState,
  createChannelConfigurationService,
} from "@/chat/configuration/service";
import type {
  ChannelConfigState,
  ChannelConfigurationService,
  ChannelConfigurationStorage,
} from "@/chat/configuration/types";

/** Create durable channel configuration storage for one provider channel. */
function createSqlChannelConfigurationStorage(
  db: JuniorDatabase,
  channelId: string,
): ChannelConfigurationStorage {
  return {
    load: async () => {
      const rows = await db
        .select({ configuration: juniorChannelConfigurations.configuration })
        .from(juniorChannelConfigurations)
        .where(eq(juniorChannelConfigurations.channelId, channelId))
        .limit(1);
      const configuration = rows[0]?.configuration;
      return configuration ? { configuration } : null;
    },
    save: async (configuration: ChannelConfigState) => {
      const updatedAt = new Date();
      await db
        .insert(juniorChannelConfigurations)
        .values({ channelId, configuration, updatedAt })
        .onConflictDoUpdate({
          target: juniorChannelConfigurations.channelId,
          set: { configuration, updatedAt },
        });
    },
  };
}

/** Resolve SQL-owned channel configuration and copy a live legacy record once. */
export function createDurableChannelConfigurationService(args: {
  channelId: string;
  db: JuniorDatabase;
  loadLegacy: () => Promise<unknown>;
}): ChannelConfigurationService {
  const sqlStorage = createSqlChannelConfigurationStorage(
    args.db,
    args.channelId,
  );
  return createChannelConfigurationService({
    load: async () => {
      const durable = await sqlStorage.load();
      if (durable) {
        return durable;
      }
      // TODO(#1267, v0.147.0): Remove after SQL readers have copied all live 7-day Redis records.
      const legacyState = coerceChannelConfigState(await args.loadLegacy());
      if (Object.keys(legacyState.entries).length === 0) {
        return null;
      }
      await sqlStorage.save(legacyState);
      return { configuration: legacyState };
    },
    save: sqlStorage.save,
  });
}
