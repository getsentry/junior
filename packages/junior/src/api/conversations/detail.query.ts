import { logException } from "@/chat/logging";
import {
  listBoundedAgentTurnSessionSummariesForConversation,
  type AgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import { buildConversationDetail } from "./detail-projection";
import { readConversationRecordFromSql } from "./list";
import type { ConversationDetailReport } from "./schema";

async function readLatestRun(
  conversationId: string,
): Promise<AgentTurnSessionSummary | undefined> {
  try {
    return (
      await listBoundedAgentTurnSessionSummariesForConversation(conversationId)
    ).find((summary) => summary.modelId || summary.reasoningLevel);
  } catch (error) {
    logException(error, "conversation_execution_settings_read_failed", {
      conversationId,
    });
    return undefined;
  }
}

/** Read one SQL conversation with its latest operational run settings. */
export async function readConversationDetailFromSql(
  conversationId: string,
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const [report, latestRun] = await Promise.all([
    buildConversationDetail({
      ...record,
      usage: record.usage ?? undefined,
    }),
    readLatestRun(conversationId),
  ]);
  return {
    ...report,
    ...(latestRun?.modelId ? { modelId: latestRun.modelId } : {}),
    ...(latestRun?.reasoningLevel
      ? { reasoningLevel: latestRun.reasoningLevel }
      : {}),
  };
}
