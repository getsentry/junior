import type { Destination } from "@sentry/junior-plugin-api";
import { getConversationStore } from "@/chat/db";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

/** Read confirmed visibility from the current signal or persisted destination. */
export async function resolveDestinationVisibility(args: {
  destination: Destination;
  visibility?: ConversationPrivacy;
}): Promise<ConversationPrivacy | undefined> {
  if (args.visibility) {
    return args.visibility;
  }
  if (args.destination.platform === "local") {
    return "private";
  }
  return await getConversationStore().getDestinationVisibility({
    provider: "slack",
    providerDestinationId: args.destination.channelId,
    providerTenantId: args.destination.teamId,
  });
}
