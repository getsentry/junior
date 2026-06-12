import type { Conversation, ConversationStore } from "../store";

export interface BackfillResult {
  copiedCount: number;
  truncated: boolean;
}

export interface BackfillTarget {
  backfillConversation(conversation: Conversation): Promise<void>;
  migrate(): Promise<void>;
}

/** Copy bounded conversation record from an existing store into SQL. */
export async function backfillToSql(args: {
  limit?: number;
  source: ConversationStore;
  target: BackfillTarget;
}): Promise<BackfillResult> {
  const limit = Math.max(0, args.limit ?? 500);
  const conversations = await args.source.listByActivity({
    limit: limit + 1,
  });
  const batch = conversations.slice(0, limit);
  await args.target.migrate();
  for (const conversation of batch) {
    await args.target.backfillConversation(conversation);
  }
  return {
    copiedCount: batch.length,
    truncated: conversations.length > limit,
  };
}
