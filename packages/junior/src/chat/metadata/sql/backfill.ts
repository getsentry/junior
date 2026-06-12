import type { ConversationMetadataStore } from "../store";
import type { Conversation } from "../state-task-execution-store";

export interface BackfillResult {
  copiedCount: number;
  hasMore: boolean;
}

export interface BackfillTarget {
  backfillConversation(conversation: Conversation): Promise<void>;
  migrate(): Promise<void>;
}

/** Copy bounded conversation metadata from an existing store into SQL. */
export async function backfillToSql(args: {
  limit?: number;
  offset?: number;
  source: ConversationMetadataStore;
  target: BackfillTarget;
}): Promise<BackfillResult> {
  const limit = Math.max(0, args.limit ?? 500);
  const offset = Math.max(0, args.offset ?? 0);
  const conversations = await args.source.listConversationsByActivity({
    limit: limit + 1,
    offset,
  });
  const batch = conversations.slice(0, limit);
  await args.target.migrate();
  for (const conversation of batch) {
    await args.target.backfillConversation(conversation);
  }
  return {
    copiedCount: batch.length,
    hasMore: conversations.length > limit,
  };
}
