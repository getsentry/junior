import { listAgentTurnSessionSummariesForConversation } from "@/chat/state/turn-session";
import { buildConversationDetail } from "./detail-projection";
import { readConversationRecordFromSql } from "./list.query";
import type { ConversationDetailReport } from "./schema";

/** Read one SQL conversation with its latest operational run settings. */
export async function readConversationDetailFromSql(
  conversationId: string,
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const latestRun = (
    await listAgentTurnSessionSummariesForConversation(conversationId)
  )[0];
  const report = await buildConversationDetail({
    ...record,
    usage: record.usage ?? undefined,
  });
  return {
    ...report,
    ...(latestRun?.modelId ? { modelId: latestRun.modelId } : {}),
    ...(latestRun?.reasoningLevel
      ? { reasoningLevel: latestRun.reasoningLevel }
      : {}),
  };
}
