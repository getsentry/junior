import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { parseDestination } from "@/chat/destination";
import type { juniorDestinations } from "@/db/schema";

export type DestinationRow = typeof juniorDestinations.$inferSelect;

/** Decode one linked destination row into its validated runtime value. */
export function destinationFromRow(
  row: DestinationRow | null,
): Destination | undefined {
  if (!row) {
    return undefined;
  }
  const value =
    row.provider === "slack"
      ? {
          platform: "slack",
          teamId: row.providerTenantId,
          channelId: row.providerDestinationId,
        }
      : row.provider === "local"
        ? {
            platform: "local",
            conversationId: row.providerDestinationId,
          }
        : undefined;
  const destination = parseDestination(value);
  if (!destination) {
    throw new Error("Conversation record destination is invalid");
  }
  return destination;
}

/** Resolve conversation privacy from one linked destination row. */
export function privacyFromDestinationRow(
  row: DestinationRow | null,
): ConversationPrivacy | undefined {
  if (!row) {
    return undefined;
  }
  return row.visibility === "public" ? "public" : "private";
}
