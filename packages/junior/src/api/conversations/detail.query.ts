import { buildConversationDetail } from "./detail-projection";
import { readConversationRecordFromSql } from "./list.query";
import type { ConversationReport } from "./types";

/** Read one conversation and its cumulative metrics from durable SQL. */
export async function readConversationDetailFromSql(
  conversationId: string,
): Promise<ConversationReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  return record
    ? buildConversationDetail({
        ...record,
        usage: record.usage ?? undefined,
      })
    : undefined;
}
