import { randomUUID } from "node:crypto";
import type { SlackDestination } from "@sentry/junior-plugin-api";
import { and, eq, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorDestinations, juniorLocationConfigurations } from "@/db/schema";
import {
  coerceLocationConfigState,
  createLocationConfigurationService,
} from "@/chat/configuration/service";
import type {
  LocationConfigState,
  LocationConfigurationService,
} from "@/chat/configuration/types";

/** Resolve the canonical Location row for a supported provider destination. */
async function resolveLocationId(
  db: JuniorDatabase,
  destination: SlackDestination,
): Promise<string> {
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
    .onConflictDoUpdate({
      target: [
        juniorDestinations.provider,
        juniorDestinations.providerTenantId,
        juniorDestinations.providerDestinationId,
      ],
      set: { id: sql`${juniorDestinations.id}` },
    })
    .returning({ id: juniorDestinations.id });
  return rows[0]!.id;
}

/** Create durable configuration storage for one Location. */
function createSqlLocationConfigurationStorage(
  db: JuniorDatabase,
  destination: SlackDestination,
) {
  const load = async () => {
    const rows = await db
      .select({ configuration: juniorLocationConfigurations.configuration })
      .from(juniorLocationConfigurations)
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorLocationConfigurations.locationId),
      )
      .where(
        and(
          eq(juniorDestinations.provider, "slack"),
          eq(juniorDestinations.providerTenantId, destination.teamId),
          eq(
            juniorDestinations.providerDestinationId,
            destination.channelId,
          ),
        ),
      )
      .limit(1);
    const configuration = rows[0]?.configuration;
    return configuration ? { configuration } : null;
  };

  return {
    load,
    save: async (configuration: LocationConfigState) => {
      const locationId = await resolveLocationId(db, destination);
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
    insertLegacy: async (configuration: LocationConfigState) => {
      const locationId = await resolveLocationId(db, destination);
      const rows = await db
        .insert(juniorLocationConfigurations)
        .values({ locationId, configuration, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: juniorLocationConfigurations.locationId,
          set: {
            configuration: sql`${juniorLocationConfigurations.configuration}`,
          },
        })
        .returning({ configuration: juniorLocationConfigurations.configuration });
      return { configuration: rows[0]!.configuration };
    },
  };
}

/** Resolve SQL-owned Location configuration and copy a live legacy record once. */
export function createDurableLocationConfigurationService(args: {
  destination: SlackDestination;
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
      return await sqlStorage.insertLegacy(legacyState);
    },
    save: sqlStorage.save,
  });
}
