import { conversationActorKey } from "../format";
import type { Conversation } from "../types";

export type ConversationListFilters = {
  query?: string;
  actor?: string;
  location?: string;
  source?: string;
  status?: "active" | "archived";
};

function conversationSearchHaystack(conversation: Conversation): string {
  const actor = conversation.actorIdentity;
  return [
    conversation.displayTitle,
    conversation.activityPreview?.text,
    conversation.id,
    conversation.channel,
    conversation.channelName,
    conversation.status,
    conversation.surface,
    actor?.email,
    actor?.fullName,
    actor?.slackUserId,
    actor?.slackUserName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Apply lightweight client-side search and facet filters to conversations. */
export function filterConversationList(
  conversations: Conversation[],
  filters: ConversationListFilters,
): Conversation[] {
  const query = filters.query?.trim().toLowerCase();
  const source = filters.source?.trim();
  const actor = filters.actor?.trim();
  const location = filters.location?.trim();
  const status = filters.status ?? "active";

  return conversations.filter((conversation) => {
    if (
      status === "archived" ? !conversation.archivedAt : conversation.archivedAt
    ) {
      return false;
    }
    if (source && conversation.surface !== source) return false;
    if (location && conversation.locationId !== location) return false;
    if (actor && conversationActorKey(conversation) !== actor) return false;
    if (query && !conversationSearchHaystack(conversation).includes(query)) {
      return false;
    }
    return true;
  });
}
