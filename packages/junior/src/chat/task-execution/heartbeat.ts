import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { logException, logInfo } from "@/chat/logging";
import type { ConversationWorkQueue } from "./queue";
import {
  clearExpiredConversationLease,
  CONVERSATION_WORK_STALE_ENQUEUE_MS,
  getConversationWorkState,
  hasRunnableConversationWork,
  claimConversationWorkRecoveryIds,
  markConversationWorkEnqueued,
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

async function sendRecoveryNudge(args: {
  conversationId: string;
  destination: Destination;
  idempotencyKey: string;
  nowMs: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<void> {
  await args.queue.send(
    {
      conversationId: args.conversationId,
      destination: args.destination,
    },
    { idempotencyKey: args.idempotencyKey },
  );
  await markConversationWorkEnqueued({
    conversationId: args.conversationId,
    nowMs: args.nowMs,
    state: args.state,
  });
}

/** Requeue expired leases and stranded mailbox work without running the agent. */
export async function recoverConversationWork(args: {
  limit?: number;
  nowMs: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<ConversationWorkRecoveryResult> {
  const result: ConversationWorkRecoveryResult = {
    expiredLeaseCount: 0,
    pendingCount: 0,
  };
  const ids = await claimConversationWorkRecoveryIds({
    limit: args.limit ?? DEFAULT_RECOVERY_LIMIT,
    state: args.state,
  });

  for (const conversationId of ids) {
    try {
      const work = await getConversationWorkState({
        conversationId,
        state: args.state,
      });
      if (!work) {
        continue;
      }

      if (work.lease && work.lease.leaseExpiresAtMs <= args.nowMs) {
        const cleared = await clearExpiredConversationLease({
          conversationId,
          nowMs: args.nowMs,
          state: args.state,
        });
        if (!cleared) {
          continue;
        }
        await sendRecoveryNudge({
          conversationId,
          destination: work.destination,
          idempotencyKey: heartbeatIdempotencyKey(
            "lease",
            conversationId,
            args.nowMs,
          ),
          nowMs: args.nowMs,
          queue: args.queue,
          state: args.state,
        });
        result.expiredLeaseCount += 1;
        logInfo(
          "conversation_work_lease_expired_requeued",
          { conversationId },
          {},
          "Heartbeat requeued expired conversation work lease",
        );
        continue;
      }

      if (work.lease || !hasRunnableConversationWork(work)) {
        continue;
      }
      if (
        typeof work.lastEnqueuedAtMs === "number" &&
        work.lastEnqueuedAtMs + CONVERSATION_WORK_STALE_ENQUEUE_MS > args.nowMs
      ) {
        continue;
      }

      await sendRecoveryNudge({
        conversationId,
        destination: work.destination,
        idempotencyKey: heartbeatIdempotencyKey(
          "pending",
          conversationId,
          args.nowMs,
        ),
        nowMs: args.nowMs,
        queue: args.queue,
        state: args.state,
      });
      result.pendingCount += 1;
      logInfo(
        "conversation_work_pending_requeued",
        { conversationId },
        {},
        "Heartbeat requeued pending conversation work",
      );
    } catch (error) {
      logException(
        error,
        "conversation_work_recovery_failed",
        { conversationId },
        {},
        "Conversation work heartbeat recovery failed",
      );
    }
  }

  return result;
}
