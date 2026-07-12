import { readConversationDetailFromSql } from "./detail.query";
import { conversationDetailReportSchema } from "./schema";
import type { ConversationDetailReport } from "./schema";

/** Load one conversation with durable content and recent run diagnostics. */
export async function readConversationDetail(
  conversationId: string,
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId);
  return report ? conversationDetailReportSchema.parse(report) : undefined;
}
