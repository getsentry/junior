import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { locationSchema, type Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";
import type { juniorDestinations } from "@/db/schema";

type LocationRow = typeof juniorDestinations.$inferSelect;

/** Build the complete Location for one Conversation SQL write. */
export function conversationLocationForWrite(args: {
  destination: Destination | undefined;
  destinationId: string | undefined;
  location: Location | undefined;
  sessionSource: SessionSource | undefined;
}): Location | undefined {
  if (args.location) {
    return locationSchema.parse(args.location);
  }
  const destination =
    args.destination?.platform === "slack" ? args.destination : undefined;
  const source =
    args.sessionSource?.platform === "slack" ? args.sessionSource : undefined;
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
    sessionSource?.platform === "slack" ? sessionSource : undefined;
  if (
    slackSource &&
    (slackSource.teamId !== row.providerTenantId ||
      slackSource.channelId !== row.providerDestinationId)
  ) {
    throw new Error("Conversation Location does not match its session Source");
  }
  return locationSchema.parse({
    id: row.id,
    provider: "slack",
    teamId: row.providerTenantId,
    channelId: row.providerDestinationId,
    ...(slackSource?.threadTs ? { threadTs: slackSource.threadTs } : undefined),
  });
}

/** Resolve conversation privacy from one linked provider-location row. */
export function privacyFromLocationRow(
  row: LocationRow | null,
): ConversationPrivacy | undefined {
  if (!row) {
    return undefined;
  }
  return row.visibility === "public" ? "public" : "private";
}
