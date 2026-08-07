import type { StateAdapter } from "chat";
import { getChatConfig } from "@/chat/config";
import { logException, logInfo, logWarn, withLogContext } from "@/chat/logging";
import type { ConversationWorkQueue } from "./queue";
import {
  clearExpiredConversationLease,
  CONVERSATION_WORK_STALE_ENQUEUE_MS,
  ensureConversationWake,
  getConversationWorkState,
  hasRunnableConversationWork,
  isInvalidConversationRecordError,
  listActiveConversationIds,
  removeActiveConversation,
  type ConversationWorkState,
} from "./store";

const DEFAULT_RECOVERY_LIMIT = 25;

export interface ConversationWorkRecoveryResult {
  expiredLeaseCount: number;
  pendingCount: number;
}

function heartbeatIdempotencyKey(
  reason: string,
  conversationId: string,
  nowMs: number,
): string {
  return `heartbeat:${reason}:${conversationId}:${nowMs}`;
}

/** Requeue expired leases and stranded mailbox work without running the agent. */
export async function recoverConversationWork(args: {
  limit?: number;
  nowMs: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<ConversationWorkRecoveryResult> {
  if (!getChatConfig().conversationWorkEnabled) {
    logWarn("conversation.work.recovery.disabled");
    return { expiredLeaseCount: 0, pendingCount: 0 };
  }
  const result: ConversationWorkRecoveryResult = {
    expiredLeaseCount: 0,
    pendingCount: 0,
  };
  const staleBeforeMs = args.nowMs - CONVERSATION_WORK_STALE_ENQUEUE_MS;
  const ids = await listActiveConversationIds({
    limit: args.limit ?? DEFAULT_RECOVERY_LIMIT,
    staleBeforeMs,
    state: args.state,
  });

  for (const conversationId of ids) {
    await withLogContext({ conversationId }, async () => {
      let work: ConversationWorkState | undefined;
      try {
        work = await getConversationWorkState({
          conversationId,
          state: args.state,
        });
      } catch (error) {
        logException(error, "conversation.work.recovery.failed");
        // An invalid record can never become runnable again; drop it from the
        // bounded oldest-first scan so it cannot starve recovery for every
        // other conversation.
        if (isInvalidConversationRecordError(error)) {
          await removeActiveConversation({
            conversationId,
            state: args.state,
          });
        }
        return;
      }
      try {
        if (!work) {
          await removeActiveConversation({
            conversationId,
            state: args.state,
          });
          return;
        }

        if (work.execution.status === "idle") {
          await removeActiveConversation({
            conversationId,
            state: args.state,
          });
          return;
        }

        if (
          work.execution.lease &&
          work.execution.lease.expiresAtMs <= args.nowMs
        ) {
          const recovery = await clearExpiredConversationLease({
            conversationId,
            nowMs: args.nowMs,
            state: args.state,
          });
          if (recovery === "not_expired") {
            return;
          }
          if (recovery === "stopped") {
            logException(
              new Error("Conversation work stopped after repeated failed attempts"),
              "conversation.work.retry.exhausted",
              {
                "app.run.id": work.execution.runId ?? "unknown",
                "app.worker.last_progress_at_ms":
                  work.execution.lastProgressAtMs ?? work.createdAtMs,
                "app.worker.retry_count":
                  (work.execution.retryCount ?? 0) + 1,
              },
            );
            return;
          }
          const wake = await ensureConversationWake({
            conversationId,
            idempotencyKey: heartbeatIdempotencyKey(
              "lease",
              conversationId,
              args.nowMs,
            ),
            nowMs: args.nowMs,
            queue: args.queue,
            replaceExistingWake: true,
            state: args.state,
          });
          if (wake.status === "enqueued") {
            result.expiredLeaseCount += 1;
            logInfo("conversation.work.lease_expired.requeued");
          }
          return;
        }

        if (work.execution.lease || !hasRunnableConversationWork(work)) {
          return;
        }

        const wake = await ensureConversationWake({
          conversationId,
          idempotencyKey: heartbeatIdempotencyKey(
            "pending",
            conversationId,
            args.nowMs,
          ),
          nowMs: args.nowMs,
          queue: args.queue,
          state: args.state,
        });
        if (wake.status === "enqueued") {
          result.pendingCount += 1;
          logInfo("conversation.work.pending.requeued");
        }
      } catch (error) {
        logException(error, "conversation.work.recovery.failed");
      }
    });
  }

  return result;
}
