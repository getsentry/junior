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
  if (value !== undefined && value !== null) {
    return locationSchema.parse(value);
  }
  if (!row || row.provider === "local") {
    return undefined;
  }
  if (row.provider !== "slack") {
    throw new Error("Conversation Location provider is not supported");
  }
  // TODO(dcramer): Remove this destination_id and source_json fallback after no
  // deployed writer can omit location_json and a backfill has populated rows
  // that those writers created during deployment.
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
