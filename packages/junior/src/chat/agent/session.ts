/**
 * Run session restore.
 *
 * Loads the persisted turn session projection for one run slice before the
 * tool and prompt phases need it, resolving the durable conversation and
 * session identifiers from routing.
 */
import { loadTurnSessionRecord } from "@/chat/services/turn-session-record";
import {
  getSessionIdentifiers,
  type AgentRunRouting,
} from "@/chat/agent/request";

type LoadedSessionRecordState = Awaited<
  ReturnType<typeof loadTurnSessionRecord>
>;

/** Restore the persisted session projection for one run slice. */
export async function restoreSessionRecord(routing: AgentRunRouting): Promise<{
  existingSessionRecord: LoadedSessionRecordState["existingSessionRecord"];
  currentSliceId: number;
  resumedFromSessionRecord: boolean;
  sessionConversationId?: string;
  sessionId?: string;
  sessionRecordState: LoadedSessionRecordState;
}> {
  const { conversationId: sessionConversationId, sessionId } =
    getSessionIdentifiers(routing);
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
