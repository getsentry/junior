import { getSessionIdentifiers } from "@/chat/agent-run-helpers";
import { loadTurnSessionRecord } from "@/chat/services/turn-session-record";
import type { AgentRunRouting } from "@/chat/agent-run/request";

type LoadedSessionRecordState = Awaited<
  ReturnType<typeof loadTurnSessionRecord>
>;

/** Restores the persisted session projection before tool and prompt phases need it. */
export async function restoreSessionRecord(routing: AgentRunRouting): Promise<{
  existingSessionRecord: LoadedSessionRecordState["existingSessionRecord"];
  currentSliceId: number;
  resumedFromSessionRecord: boolean;
  sessionConversationId?: string;
  sessionId?: string;
  sessionRecordState: LoadedSessionRecordState;
}> {
  const { conversationId: sessionConversationId, sessionId } =
    getSessionIdentifiers({ correlation: routing.correlation });
  const sessionRecordState = await loadTurnSessionRecord({
    conversationId: sessionConversationId,
    sessionId,
  });
  const { resumedFromSessionRecord, currentSliceId, existingSessionRecord } =
    sessionRecordState;
  return {
    currentSliceId,
    existingSessionRecord,
    resumedFromSessionRecord,
    sessionConversationId,
    sessionId,
    sessionRecordState,
  };
}
