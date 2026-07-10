import { getConversationStore } from "@/chat/db";
import type { ConversationMessageStore } from "@/chat/conversations/messages";
import type { ConversationStore } from "@/chat/conversations/store";

export interface ConversationReaderOptions {
  messageStore?: ConversationMessageStore;
  conversationStore?: ConversationStore;
}

/** Resolve the conversation store supplied by a reporting consumer. */
export function conversationStore(
  options: ConversationReaderOptions = {},
): ConversationStore {
  return options.conversationStore ?? getConversationStore();
}
