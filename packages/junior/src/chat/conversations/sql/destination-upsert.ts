import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { JuniorDestinationKind } from "@/db/schema/destination-kind";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

/** One Destination row to insert or refresh. */
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

/** Build the Destination row of a Conversation's Destination, if it has one. */
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
