import type { Destination } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorDestinationConfigurations } from "@/db/schema";
import { destinationKey } from "@/chat/destination";
import {
  coerceDestinationConfigState,
  createDestinationConfigurationService,
} from "@/chat/configuration/service";
import type {
  DestinationConfigState,
  DestinationConfigurationService,
  DestinationConfigurationStorage,
} from "@/chat/configuration/types";

/** Create durable destination configuration storage for one destination key. */
function createSqlDestinationConfigurationStorage(
  db: JuniorDatabase,
  key: string,
): DestinationConfigurationStorage {
  return {
    load: async () => {
      const rows = await db
        .select({ configuration: juniorDestinationConfigurations.configuration })
        .from(juniorDestinationConfigurations)
        .where(eq(juniorDestinationConfigurations.destinationKey, key))
        .limit(1);
      const configuration = rows[0]?.configuration;
      return configuration ? { configuration } : null;
    },
    save: async (configuration: DestinationConfigState) => {
      const updatedAt = new Date();
      await db
        .insert(juniorDestinationConfigurations)
        .values({ destinationKey: key, configuration, updatedAt })
        .onConflictDoUpdate({
          target: juniorDestinationConfigurations.destinationKey,
          set: { configuration, updatedAt },
        });
    },
  };
}

/** Resolve SQL-owned destination configuration and copy a live legacy record once. */
export function createDurableDestinationConfigurationService(args: {
  destination: Destination;
  db: JuniorDatabase;
  loadLegacy: () => Promise<unknown>;
}): DestinationConfigurationService {
  const key = destinationKey(args.destination);
  const sqlStorage = createSqlDestinationConfigurationStorage(args.db, key);
  return createDestinationConfigurationService({
    load: async () => {
      const durable = await sqlStorage.load();
      if (durable) {
        return durable;
      }
      // TODO(#1267, v0.147.0): Remove after SQL readers have copied all live 7-day Redis records.
      const legacyState = coerceDestinationConfigState(await args.loadLegacy());
      if (Object.keys(legacyState.entries).length === 0) {
        return null;
      }
      await sqlStorage.save(legacyState);
      return { configuration: legacyState };
    },
    save: sqlStorage.save,
  });
}
