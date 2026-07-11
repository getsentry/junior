import { buildConversationSubagent } from "./detail-projection";
import { readConversationRecordFromSql } from "./list.query";
import { conversationSubagentTranscriptReportSchema } from "./schema";
import type { ConversationSubagentTranscriptReport } from "./schema";

/** Load one child-agent transcript from durable SQL conversation history. */
export async function readConversationSubagent(
  conversationId: string,
  subagentId: string,
): Promise<ConversationSubagentTranscriptReport> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) {
    return conversationSubagentTranscriptReportSchema.parse({
      type: "subagent",
      createdAt: new Date(0).toISOString(),
      id: subagentId,
      status: "error",
      subagentKind: "unknown",
      transcript: [],
      transcriptAvailable: false,
      unavailableReason: "not_found",
    });
  }
  return conversationSubagentTranscriptReportSchema.parse(
    await buildConversationSubagent(record.conversation, subagentId),
  );
}
