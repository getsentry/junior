import type { Conversation, ConversationStore } from "../store";

export interface BackfillResult {
  copiedCount: number;
}

export interface BackfillTarget {
  backfillConversation(conversation: Conversation): Promise<void>;
  migrate(): Promise<void>;
}

/** Copy bounded legacy conversation metadata from an existing store into SQL. */
export async function backfillToSql(args: {
  limit?: number;
  source: ConversationStore;
  target: BackfillTarget;
}): Promise<BackfillResult> {
  const limit = Math.max(0, args.limit ?? 500);
  const conversations = await args.source.listByActivity({
    limit,
  });
  await args.target.migrate();
  for (const conversation of conversations) {
    await args.target.backfillConversation(conversation);
  }
  return {
    copiedCount: conversations.length,
  };
}
