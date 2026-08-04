import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { locationSchema, type Location } from "@/chat/conversations/location";
import type { juniorDestinations } from "@/db/schema";

type LocationRow = typeof juniorDestinations.$inferSelect;

/** Project one supported provider location from its linked SQL row. */
export function locationFromRow(row: LocationRow | null): Location | undefined {
  if (
    !row ||
    row.provider !== "slack" ||
    (row.kind !== "channel" && row.kind !== "dm" && row.kind !== "group")
  ) {
    return undefined;
  }
  return locationSchema.parse({
    provider: "slack",
    teamId: row.providerTenantId,
    channelId: row.providerDestinationId,
    kind: row.kind,
    visibility: row.visibility === "public" ? "public" : "private",
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
