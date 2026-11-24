/** Map a Conversation Destination to and from its `junior_destinations` row. */
import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { parseDestination } from "@/chat/destination";
import type { juniorDestinations } from "@/db/schema";
import type { JuniorDestinationKind } from "@/db/schema/destination-kind";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

type DestinationRow = typeof juniorDestinations.$inferSelect;

/** The `junior_destinations` row that one Destination writes. */
export interface DestinationUpsert {
  displayName?: string;
  kind: JuniorDestinationKind;
  metadata?: Record<string, unknown>;
  provider: string;
  providerDestinationId: string;
  providerTenantId?: string | undefined;
  refreshVisibility: boolean;
  visibility: JuniorDestinationVisibility;
}

function localWorkspaceFromConversationId(
  conversationId: string,
): string | undefined {
  const match = /^local:([^:]+):/.exec(conversationId);
  return match?.[1];
}

/** Map a Destination to the row that it writes, if it has one. */
export function destinationUpsertFromDestination(args: {
  channelName?: string | undefined;
  conversationId?: string;
  destination: Destination | undefined;
  /** Confirmed destination visibility; omit when unavailable. */
  visibility?: ConversationPrivacy;
}): DestinationUpsert | undefined {
  const { destination } = args;
  if (!destination) {
    return undefined;
  }
  if (destination.platform === "slack") {
    const channelId = destination.channelId;
    const channelKind = channelId.startsWith("D")
      ? "dm"
      : channelId.startsWith("G")
        ? "group"
        : "channel";
    return {
      kind: channelKind,
      provider: "slack",
      providerTenantId: destination.teamId,
      providerDestinationId: channelId,
      refreshVisibility: args.visibility !== undefined,
      visibility: args.visibility ?? "unknown",
      ...(args.channelName ? { displayName: args.channelName } : undefined),
      metadata: { platform: "slack" },
    };
  }
  return {
    kind: "local_conversation",
    provider: "local",
    providerTenantId:
      localWorkspaceFromConversationId(destination.conversationId) ??
      localWorkspaceFromConversationId(args.conversationId ?? ""),
    providerDestinationId: destination.conversationId,
    // Match Slack: only refresh when a live visibility signal is present so
    // execution-metadata writes cannot clobber public dashboard roots.
    refreshVisibility: args.visibility !== undefined,
    visibility: args.visibility ?? "direct",
    metadata: { platform: "local" },
  };
}

/** Decode a `junior_destinations` row to its Destination. */
export function destinationFromRow(
  destination: DestinationRow | null,
): Destination | undefined {
  const value =
    destination?.provider === "slack"
      ? {
          platform: "slack",
          teamId: destination.providerTenantId,
          channelId: destination.providerDestinationId,
        }
      : destination?.provider === "local"
        ? {
            platform: "local",
            conversationId: destination.providerDestinationId,
          }
        : undefined;
  return parseDestination(value);
}
