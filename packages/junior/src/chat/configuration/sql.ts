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
  ConfigEntry,
  LocationConfigurationService,
} from "@/chat/configuration/types";

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

function createSqlLocationConfigurationStorage(
  db: JuniorDatabase,
  destination: SlackDestination,
) {
  const locationWhere = and(
    eq(juniorDestinations.provider, "slack"),
    eq(juniorDestinations.providerTenantId, destination.teamId),
    eq(juniorDestinations.providerDestinationId, destination.channelId),
  );

  const list = async (): Promise<ConfigEntry[]> => {
    const rows = await db
      .select({
        key: juniorLocationConfigurations.key,
        value: juniorLocationConfigurations.value,
        updatedAt: juniorLocationConfigurations.updatedAt,
        updatedBy: juniorLocationConfigurations.updatedBy,
        source: juniorLocationConfigurations.source,
        expiresAt: juniorLocationConfigurations.expiresAt,
      })
      .from(juniorLocationConfigurations)
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorLocationConfigurations.locationId),
      )
      .where(locationWhere);
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value) as unknown,
      scope: "location",
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy ?? undefined,
      source: row.source ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
    }));
  };

  const set = async (entry: ConfigEntry): Promise<void> => {
    const locationId = await resolveLocationId(db, destination);
    await db
      .insert(juniorLocationConfigurations)
      .values({
        locationId,
        key: entry.key,
        value: JSON.stringify(entry.value),
        updatedAt: new Date(entry.updatedAt),
        updatedBy: entry.updatedBy,
        source: entry.source,
        expiresAt: entry.expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          juniorLocationConfigurations.locationId,
          juniorLocationConfigurations.key,
        ],
        set: {
          value: JSON.stringify(entry.value),
          updatedAt: new Date(entry.updatedAt),
          updatedBy: entry.updatedBy,
          source: entry.source,
          expiresAt: entry.expiresAt,
        },
      });
  };

  return {
    list,
    set,
    unset: async (key: string): Promise<boolean> => {
      const locationId = await resolveLocationId(db, destination);
      const rows = await db
        .delete(juniorLocationConfigurations)
        .where(
          and(
            eq(juniorLocationConfigurations.locationId, locationId),
            eq(juniorLocationConfigurations.key, key),
          ),
        )
        .returning({ key: juniorLocationConfigurations.key });
      return rows.length > 0;
    },
    insertLegacy: async (entries: ConfigEntry[]): Promise<void> => {
      if (entries.length === 0) {
        return;
      }
      const locationId = await resolveLocationId(db, destination);
      await db
        .insert(juniorLocationConfigurations)
        .values(
          entries.map((entry) => ({
            locationId,
            key: entry.key,
            value: JSON.stringify(entry.value),
            updatedAt: new Date(entry.updatedAt),
            updatedBy: entry.updatedBy,
            source: entry.source,
            expiresAt: entry.expiresAt,
          })),
        )
        .onConflictDoNothing();
    },
  };
}

/** Resolve SQL-owned Location configuration and copy live legacy entries once. */
export function createDurableLocationConfigurationService(args: {
  destination: SlackDestination;
  db: JuniorDatabase;
  loadLegacy: () => Promise<unknown>;
}): LocationConfigurationService {
  const storage = createSqlLocationConfigurationStorage(args.db, args.destination);
  let cutover: Promise<void> | undefined;
  const ensureCutover = () =>
    (cutover ??= (async () => {
      if ((await storage.list()).length > 0) {
        return;
      }
      // TODO(#1267, v0.147.0): Remove after SQL readers have copied all live 7-day Redis records.
      const legacy = coerceLocationConfigState(await args.loadLegacy());
      await storage.insertLegacy(Object.values(legacy.entries));
    })());

  return createLocationConfigurationService({
    list: async () => {
      await ensureCutover();
      return await storage.list();
    },
    set: storage.set,
    unset: storage.unset,
  });
}
