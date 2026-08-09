import { randomUUID } from "node:crypto";
import type { Destination } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorDestinations, juniorLocationConfigurations } from "@/db/schema";
import {
  coerceLocationConfigState,
  createLocationConfigurationService,
} from "@/chat/configuration/service";
import type {
  LocationConfigState,
  LocationConfigurationService,
  LocationConfigurationStorage,
} from "@/chat/configuration/types";

/** Resolve the canonical Location row for a supported provider destination. */
async function resolveLocationId(
  db: JuniorDatabase,
  destination: Destination,
): Promise<string> {
  if (destination.platform !== "slack") {
    throw new Error("Location configuration requires a provider Location");
  }

  const channelId = destination.channelId;
  const now = new Date();
  const rows = await db
    .insert(juniorDestinations)
    .values({
      id: randomUUID(),
      provider: "slack",
      providerTenantId: destination.teamId,
      providerDestinationId: channelId,
      kind: channelId.startsWith("D")
        ? "dm"
        : channelId.startsWith("G")
          ? "group"
          : "channel",
      parentDestinationId: null,
      displayName: null,
      visibility: "unknown",
      metadata: { platform: "slack" },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        juniorDestinations.provider,
        juniorDestinations.providerTenantId,
        juniorDestinations.providerDestinationId,
      ],
    })
    .returning({ id: juniorDestinations.id });
  const locationId = rows[0]?.id;
  if (locationId) {
    return locationId;
  }

  const existing = await db
    .select({ id: juniorDestinations.id })
    .from(juniorDestinations)
    .where(
      and(
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.providerTenantId, destination.teamId),
        eq(juniorDestinations.providerDestinationId, channelId),
      ),
    )
    .limit(1);
  if (!existing[0]?.id) {
    throw new Error("Location could not be resolved");
  }
  return existing[0].id;
}

/** Create durable configuration storage for one Location. */
function createSqlLocationConfigurationStorage(
  db: JuniorDatabase,
  destination: Destination,
): LocationConfigurationStorage & {
  insertIfAbsent: (configuration: LocationConfigState) => Promise<void>;
} {
  let locationIdPromise: Promise<string> | undefined;
  const getLocationId = () =>
    (locationIdPromise ??= resolveLocationId(db, destination));

  const load = async () => {
    const locationId = await getLocationId();
    const rows = await db
      .select({ configuration: juniorLocationConfigurations.configuration })
      .from(juniorLocationConfigurations)
      .where(eq(juniorLocationConfigurations.locationId, locationId))
      .limit(1);
    const configuration = rows[0]?.configuration;
    return configuration ? { configuration } : null;
  };

  return {
    load,
    save: async (configuration: LocationConfigState) => {
      const locationId = await getLocationId();
      const updatedAt = new Date();
      await db
        .insert(juniorLocationConfigurations)
        .values({ locationId, configuration, updatedAt })
        .onConflictDoUpdate({
          target: juniorLocationConfigurations.locationId,
          set: { configuration, updatedAt },
        });
    },
    // Cutover must never overwrite a concurrent SQL write.
    insertIfAbsent: async (configuration: LocationConfigState) => {
      const locationId = await getLocationId();
      const updatedAt = new Date();
      await db
        .insert(juniorLocationConfigurations)
        .values({ locationId, configuration, updatedAt })
        .onConflictDoNothing({
          target: juniorLocationConfigurations.locationId,
        });
    },
  };
}

/** Resolve SQL-owned Location configuration and copy a live legacy record once. */
export function createDurableLocationConfigurationService(args: {
  destination: Destination;
  db: JuniorDatabase;
  loadLegacy: () => Promise<unknown>;
}): LocationConfigurationService {
  const sqlStorage = createSqlLocationConfigurationStorage(
    args.db,
    args.destination,
  );
  return createLocationConfigurationService({
    load: async () => {
      const durable = await sqlStorage.load();
      if (durable) {
        return durable;
      }
      // TODO(#1267, v0.147.0): Remove after SQL readers have copied all live 7-day Redis records.
      const legacyState = coerceLocationConfigState(await args.loadLegacy());
      if (Object.keys(legacyState.entries).length === 0) {
        return null;
      }
      await sqlStorage.insertIfAbsent(legacyState);
      // Prefer any SQL row that landed during the cutover window.
      return (await sqlStorage.load()) ?? { configuration: legacyState };
    },
    save: sqlStorage.save,
  });
}
