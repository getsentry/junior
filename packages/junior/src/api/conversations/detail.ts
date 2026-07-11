import { readConversationDetailFromSql } from "./detail.query";
import type { ConversationReport } from "./types";

/** Load one conversation directly from durable SQL records. */
export async function readConversationDetail(
  conversationId: string,
): Promise<ConversationReport | undefined> {
  return readConversationDetailFromSql(conversationId);
}

export type {
  ConversationActivityReport,
  ConversationActivityStatus,
  ConversationReport,
  ConversationRunReport,
  ConversationSubagentActivityReport,
  ConversationToolActivityReport,
  TranscriptMessage,
  TranscriptPart,
  TranscriptPartType,
  TranscriptRole,
} from "./types";
