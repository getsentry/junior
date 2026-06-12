import type { ConversationMetadataStore } from "../store";
import type { Conversation } from "../state-task-execution-store";

export interface ConversationMetadataBackfillResult {
  copiedCount: number;
  hasMore: boolean;
}

export interface ConversationMetadataSqlBackfillTarget {
  backfillConversation(conversation: Conversation): Promise<void>;
  ensureSchema(): Promise<void>;
}

/** Copy bounded conversation metadata from an existing store into SQL. */
export async function backfillConversationMetadataToSql(args: {
  limit?: number;
  source: ConversationMetadataStore;
  target: ConversationMetadataSqlBackfillTarget;
}): Promise<ConversationMetadataBackfillResult> {
  const limit = Math.max(0, args.limit ?? 500);
  const conversations = await args.source.listConversationsByActivity({
    limit: limit + 1,
  });
  const batch = conversations.slice(0, limit);
  await args.target.ensureSchema();
  for (const conversation of batch) {
    await args.target.backfillConversation(conversation);
  }
  return {
    copiedCount: batch.length,
    hasMore: conversations.length > limit,
  };
}
