/**
 * Run session restore.
 *
 * Loads the persisted turn session projection for one run slice before the
 * tool and prompt phases need it.
 */
import { loadTurnSessionRecord } from "@/chat/services/turn-session-record";

type LoadedSessionRecordState = Awaited<
  ReturnType<typeof loadTurnSessionRecord>
>;

/** Restore the persisted session projection for one run slice. */
export async function restoreSessionRecord(args: {
  conversationId: string;
  turnId: string;
}): Promise<{
  existingSessionRecord: LoadedSessionRecordState["existingSessionRecord"];
  currentSliceId: number;
  resumedFromSessionRecord: boolean;
  sessionRecordState: LoadedSessionRecordState;
}> {
  const sessionRecordState = await loadTurnSessionRecord({
    conversationId: args.conversationId,
    sessionId: args.turnId,
  });
  const { resumedFromSessionRecord, currentSliceId, existingSessionRecord } =
    sessionRecordState;
  return {
    currentSliceId,
    existingSessionRecord,
    resumedFromSessionRecord,
    sessionRecordState,
  };
}
