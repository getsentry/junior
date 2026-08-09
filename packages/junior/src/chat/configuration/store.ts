import { eq } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import type { ChannelConfigState } from "@/chat/configuration/types";
import { juniorChannelConfigurations } from "@/db/schema/channel-configurations";
import { sanitizePostgresJson } from "@/db/postgres-json";

function dateFromMs(ms: number): Date {
  return new Date(ms);
}

/** Load durable channel configuration entries for one channel id. */
export async function loadChannelConfiguration(
  channelId: string,
): Promise<ChannelConfigState | null> {
  const rows = await getSqlExecutor()
    .db()
    .select({
      entries: juniorChannelConfigurations.entries,
      schemaVersion: juniorChannelConfigurations.schemaVersion,
    })
    .from(juniorChannelConfigurations)
    .where(eq(juniorChannelConfigurations.channelId, channelId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    schemaVersion: 1,
    entries: row.entries ?? {},
  };
}

/** Replace durable channel configuration for one channel id. */
export async function saveChannelConfiguration(
  channelId: string,
  state: ChannelConfigState,
  nowMs = Date.now(),
): Promise<void> {
  const now = dateFromMs(nowMs);
  const entries = sanitizePostgresJson(state.entries);
  await getSqlExecutor()
    .db()
    .insert(juniorChannelConfigurations)
    .values({
      channelId,
      schemaVersion: 1,
      entries,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: juniorChannelConfigurations.channelId,
      set: {
        schemaVersion: 1,
        entries,
        updatedAt: now,
      },
    });
}
