import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore } from "@/chat/db";

/**
 * Return the Conversation bound to one Slack thread, such as an Automation
 * run that posted the thread. Slack input in a bound thread goes to that
 * Conversation. An unbound thread belongs to `slack:<channel>:<threadTs>`.
 */
export async function findSlackThreadOwnerId(args: {
  channelId: string;
  conversationStore?: ConversationStore;
  teamId: string;
  threadTs: string;
}): Promise<string | undefined> {
  const conversationStore = args.conversationStore ?? getConversationStore();
  return await conversationStore.getConversationIdByProviderConversation({
    provider: "slack",
    providerConversationId: args.threadTs,
    providerDestinationId: args.channelId,
    providerTenantId: args.teamId,
  });
}
