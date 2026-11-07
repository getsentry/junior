import type { Destination } from "@sentry/junior-plugin-api";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { locationSchema, type Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, type juniorDestinations } from "@/db/schema";
import type { ProviderConversationBinding } from "./bindings";
import { nextDetailVersion } from "./detail-version";

type LocationRow = typeof juniorDestinations.$inferSelect;

/** Build the complete Location for one Conversation SQL write. */
// TODO(dcramer): Remove Destination and SessionSource inputs after every
// Conversation writer supplies Location directly.
export function locationForWrite(args: {
  destination: Destination | undefined;
  destinationId: string | undefined;
  location: Location | undefined;
  sessionSource: SessionSource | undefined;
}): Location | undefined {
  const location = args.location
    ? locationSchema.parse(args.location)
    : undefined;
  const destination =
    args.destination?.platform === "slack" ? args.destination : undefined;
  const source =
    args.sessionSource?.kind === "slack" ? args.sessionSource : undefined;
  if (location) {
    if (
      (destination &&
        (location.id !== args.destinationId ||
          location.teamId !== destination.teamId ||
          location.channelId !== destination.channelId)) ||
      (source &&
        (location.teamId !== source.teamId ||
          location.channelId !== source.channelId))
    ) {
      throw new Error("Conversation Location changed");
    }
    const threadTs =
      location.threadTs ?? destination?.threadTs ?? source?.threadTs;
    return threadTs === location.threadTs
      ? location
      : { ...location, threadTs };
  }
  if (
    destination &&
    source &&
    (destination.teamId !== source.teamId ||
      destination.channelId !== source.channelId)
  ) {
    throw new Error("Conversation Location does not match its session Source");
  }
  if (!destination || !args.destinationId) {
    return undefined;
  }
  const threadTs = destination.threadTs ?? source?.threadTs;
  return locationSchema.parse({
    id: args.destinationId,
    provider: "slack",
    teamId: destination.teamId,
    channelId: destination.channelId,
    ...(threadTs ? { threadTs } : undefined),
  });
}

/** Read one complete Location from SQL. */
export function locationFromRow(
  value: unknown,
  row: LocationRow | null,
  sessionSource: SessionSource | undefined,
): Location | undefined {
  // TODO(dcramer): Remove these destination_id and source_json fallbacks after
  // no deployed writer can omit location_json or its threadTs and a backfill
  // has completed rows that those writers created during deployment.
  if (value !== undefined && value !== null) {
    const location = locationSchema.parse(value);
    const slackSource =
      !location.threadTs &&
      sessionSource?.kind === "slack" &&
      sessionSource.teamId === location.teamId &&
      sessionSource.channelId === location.channelId
        ? sessionSource
        : undefined;
    return slackSource?.threadTs
      ? { ...location, threadTs: slackSource.threadTs }
      : location;
  }
  if (!row || row.provider === "local") {
    return undefined;
  }
  if (row.provider !== "slack") {
    throw new Error("Conversation Location provider is not supported");
  }
  const slackSource =
    sessionSource?.kind === "slack" &&
    sessionSource.teamId === row.providerTenantId &&
    sessionSource.channelId === row.providerDestinationId
      ? sessionSource
      : undefined;
  return locationSchema.parse({
    id: row.id,
    provider: "slack",
    teamId: row.providerTenantId,
    channelId: row.providerDestinationId,
    ...(slackSource?.threadTs ? { threadTs: slackSource.threadTs } : undefined),
  });
}

/** Read confirmed visibility from one linked Location row. */
export function visibilityFromLocationRow(
  row: LocationRow | null,
): ConversationPrivacy | undefined {
  if (!row) {
    return undefined;
  }
  if (row.visibility === "public" || row.visibility === "private") {
    return row.visibility;
  }
  return undefined;
}

/**
 * Give every descendant of a root Conversation the root's Location and
 * Destination row, in the caller's transaction. Each write that changes
 * either value on a root calls this, so a child never keeps an old Location.
 */
export async function saveLocationOnDescendants(
  executor: JuniorSqlDatabase,
  rootConversationId: string,
): Promise<void> {
  // UNION, not UNION ALL, so that bad parent links cannot loop forever.
  const descendantIds = sql`(
    with recursive descendants(conversation_id) as (
      select child.conversation_id
      from junior_conversations child
      where child.parent_conversation_id = ${rootConversationId}
      union
      select child.conversation_id
      from junior_conversations child
      join descendants on child.parent_conversation_id = descendants.conversation_id
    )
    select conversation_id from descendants
  )`;
  // Lock the descendants first. createChild holds a share lock on the parent
  // row while it copies it, so a child that commits during this wait is
  // found by the update below, which reads a new snapshot.
  const locked = await executor
    .db()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, descendantIds))
    .for("no key update");
  if (locked.length === 0) {
    return;
  }
  await executor
    .db()
    .update(juniorConversations)
    .set({
      location: sql`(select root.location_json from junior_conversations root where root.conversation_id = ${rootConversationId})`,
      destinationId: sql`(select root.destination_id from junior_conversations root where root.conversation_id = ${rootConversationId})`,
      detailVersion: nextDetailVersion,
    })
    .where(inArray(juniorConversations.conversationId, descendantIds));
}

/**
 * Give a root Conversation with no Location its first one, in the caller's
 * SQL scope. The Location row becomes the Conversation Destination, so
 * visibility then comes from that channel. Returns false when the
 * Conversation already has a Location.
 */
export async function setFirstConversationLocation(
  executor: JuniorSqlDatabase,
  args: {
    channelName?: string;
    conversationId: string;
    location: Location;
  },
): Promise<boolean> {
  const location = locationSchema.parse(args.location);
  const rows = await executor
    .db()
    .update(juniorConversations)
    .set({
      location,
      destinationId: location.id,
      ...(args.channelName ? { channelName: args.channelName } : undefined),
      detailVersion: nextDetailVersion,
    })
    .where(
      and(
        eq(juniorConversations.conversationId, args.conversationId),
        isNull(juniorConversations.parentConversationId),
        isNull(juniorConversations.location),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  if (rows.length === 0) {
    return false;
  }
  await saveLocationOnDescendants(executor, args.conversationId);
  return true;
}

/** Store a channel-level Location's first bound post as its thread. */
export async function startLocationThread(
  executor: JuniorSqlDatabase,
  binding: ProviderConversationBinding,
): Promise<void> {
  const location = juniorConversations.location;
  const rows = await executor
    .db()
    .update(juniorConversations)
    .set({
      location: sql`${location} || jsonb_build_object('threadTs', ${binding.providerConversationId}::text)`,
      detailVersion: nextDetailVersion,
    })
    .where(
      and(
        eq(juniorConversations.conversationId, binding.conversationId),
        // A child's Location is its root's. Only the root changes it.
        isNull(juniorConversations.parentConversationId),
        sql`${location}->>'provider' = ${binding.provider}`,
        sql`${location}->>'teamId' = ${binding.providerTenantId}`,
        sql`${location}->>'channelId' = ${binding.providerDestinationId}`,
        isNull(sql`${location}->>'threadTs'`),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  if (rows.length > 0) {
    await saveLocationOnDescendants(executor, binding.conversationId);
  }
}
