import { logException } from "@/chat/logging";
import {
  getAgentTurnSessionRecord,
  listBoundedAgentTurnSessionSummariesForConversation,
  type AgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import { buildConversationDetail } from "./detail-projection";
import { readConversationRecordFromSql } from "./list.query";
import type { ConversationDetailReport } from "./schema";
import { getConversationTurnStore } from "@/chat/db";

async function readReportedRun(
  conversationId: string,
): Promise<AgentTurnSessionSummary | undefined> {
  try {
    const summaries =
      await listBoundedAgentTurnSessionSummariesForConversation(conversationId);
    const summary = summaries[0];
    if (!summary) {
      return undefined;
    }
    if (summary?.modelId || summary?.reasoningLevel) {
      return summary;
    }
    return await getAgentTurnSessionRecord(conversationId, summary.sessionId);
  } catch (error) {
    logException(error, "conversation_execution_settings_read_failed", {
      conversationId,
    });
    return undefined;
  }
}

async function readLatestTurnModelId(
  conversationId: string,
  turnId: string | undefined,
): Promise<string | undefined> {
  if (!turnId) {
    return undefined;
  }
  const turn = await getConversationTurnStore().get(conversationId, turnId);
  if (!turn) {
    return undefined;
  }
  return turn.startingModelId;
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
    readReportedRun(conversationId),
  ]);
  const modelId = await readLatestTurnModelId(
    conversationId,
    latestRun?.sessionId ?? record.conversation.execution.runId,
  );
  // TODO(v0.102.0): Remove the session-model fallback after every retained
  // conversation turn was created after junior_conversation_turns shipped.
  const reportedModelId = modelId ?? latestRun?.modelId;
  return {
    ...report,
    ...(reportedModelId ? { modelId: reportedModelId } : {}),
    ...(latestRun?.reasoningLevel
      ? { reasoningLevel: latestRun.reasoningLevel }
      : {}),
  };
}
