import { readConversationFeedFromSql } from "./list.query";
import { conversationFeedSchema } from "./schema";
import type { ConversationFeed } from "./schema";

/** Load the conversation feed directly from durable SQL records. */
export async function readConversationFeed(): Promise<ConversationFeed> {
  return conversationFeedSchema.parse(await readConversationFeedFromSql());
}
