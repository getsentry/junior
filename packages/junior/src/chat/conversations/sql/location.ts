import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { locationSchema, type Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";
import type { juniorDestinations } from "@/db/schema";

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
    return source?.threadTs && !location.threadTs
      ? { ...location, threadTs: source.threadTs }
      : location;
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
  return locationSchema.parse({
    id: args.destinationId,
    provider: "slack",
    teamId: destination.teamId,
    channelId: destination.channelId,
    ...(source?.threadTs ? { threadTs: source.threadTs } : undefined),
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
