import type { StateAdapter } from "chat";
import { logException, logInfo, logWarn } from "@/chat/logging";
import type { ConversationWorkQueue } from "./queue";
import {
  checkInConversationWork,
  completeConversationWork,
  CONVERSATION_WORK_CHECK_IN_INTERVAL_MS,
  countPendingConversationMessages,
  drainConversationMailbox,
  getConversationWorkState,
  markConversationWorkEnqueued,
  releaseConversationWork,
  requestConversationContinuation,
  startConversationWork,
  type InboundMessageRecord,
} from "./store";

export const CONVERSATION_WORK_DEFER_DELAY_MS = 15_000;
export const CONVERSATION_WORK_SOFT_YIELD_AFTER_MS = 240_000;

export interface ConversationWorkerContext {
  checkIn(): Promise<boolean>;
  conversationId: string;
  drainMailbox(
    inject: (messages: InboundMessageRecord[]) => Promise<void>,
  ): Promise<InboundMessageRecord[]>;
  leaseToken: string;
  shouldYield(): boolean;
}

export interface ConversationWorkerResult {
  status: "completed" | "yielded";
}

export interface ConversationWorkProcessResult {
  status:
    | "active"
    | "completed"
    | "lost_lease"
    | "no_work"
    | "pending_requeued"
    | "yielded";
}

export interface ProcessConversationWorkOptions {
  checkInIntervalMs?: number;
  nowMs?: () => number;
  queue: ConversationWorkQueue;
  run(context: ConversationWorkerContext): Promise<ConversationWorkerResult>;
  softYieldAfterMs?: number;
  state?: StateAdapter;
}

function now(options: ProcessConversationWorkOptions): number {
  return options.nowMs?.() ?? Date.now();
}

function nudgeIdempotencyKey(reason: string, conversationId: string): string {
  return `${reason}:${conversationId}`;
}

async function sendWakeNudge(args: {
  conversationId: string;
  delayMs?: number;
  idempotencyKey: string;
  nowMs: number;
  options: ProcessConversationWorkOptions;
}): Promise<void> {
  await args.options.queue.send(
    { conversationId: args.conversationId },
    {
      delayMs: args.delayMs,
      idempotencyKey: args.idempotencyKey,
    },
  );
  await markConversationWorkEnqueued({
    conversationId: args.conversationId,
    nowMs: args.nowMs,
    state: args.options.state,
  });
}

function startLeaseCheckIn(args: {
  conversationId: string;
  leaseToken: string;
  options: ProcessConversationWorkOptions;
}): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const nowMs = now(args.options);
    void checkInConversationWork({
      conversationId: args.conversationId,
      leaseToken: args.leaseToken,
      nowMs,
      state: args.options.state,
    }).then(
      (checkedIn) => {
        if (!checkedIn) {
          logWarn(
            "conversation_work_check_in_failed",
            { conversationId: args.conversationId },
            {},
            "Conversation work check-in lost its lease",
          );
        }
      },
      (error) => {
        logException(
          error,
          "conversation_work_check_in_failed",
          { conversationId: args.conversationId },
          {},
          "Conversation work check-in failed",
        );
      },
    );
  }, args.options.checkInIntervalMs ?? CONVERSATION_WORK_CHECK_IN_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Process one queue wake-up for a conversation. */
export async function processConversationWork(
  conversationId: string,
  options: ProcessConversationWorkOptions,
): Promise<ConversationWorkProcessResult> {
  const initial = await getConversationWorkState({
    conversationId,
    state: options.state,
  });
  if (
    !initial ||
    (countPendingConversationMessages(initial) === 0 &&
      !initial.needsRun &&
      !initial.lease)
  ) {
    return { status: "no_work" };
  }

  const lease = await startConversationWork({
    conversationId,
    nowMs: now(options),
    state: options.state,
  });
  if (lease.status === "no_work") {
    return { status: "no_work" };
  }
  if (lease.status === "active") {
    await sendWakeNudge({
      conversationId,
      delayMs: CONVERSATION_WORK_DEFER_DELAY_MS,
      idempotencyKey: nudgeIdempotencyKey("active", conversationId),
      nowMs: now(options),
      options,
    });
    logInfo(
      "conversation_work_nudge_deferred_for_active_lease",
      { conversationId },
      {
        "app.lease.expires_at_ms": lease.leaseExpiresAtMs,
      },
      "Conversation work nudge deferred for active lease",
    );
    return { status: "active" };
  }

  const startedAtMs = now(options);
  const softYieldDeadlineMs =
    startedAtMs +
    (options.softYieldAfterMs ?? CONVERSATION_WORK_SOFT_YIELD_AFTER_MS);
  const timer = startLeaseCheckIn({
    conversationId,
    leaseToken: lease.leaseToken,
    options,
  });
  logInfo(
    "conversation_work_lease_acquired",
    { conversationId },
    {
      "app.lease.expires_at_ms": lease.leaseExpiresAtMs,
      "app.worker.soft_yield_deadline_ms": softYieldDeadlineMs,
    },
    "Conversation work lease acquired",
  );

  const workerContext: ConversationWorkerContext = {
    conversationId,
    leaseToken: lease.leaseToken,
    shouldYield: () => now(options) >= softYieldDeadlineMs,
    checkIn: () =>
      checkInConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        state: options.state,
      }),
    drainMailbox: (inject) =>
      drainConversationMailbox({
        conversationId,
        leaseToken: lease.leaseToken,
        inject,
        nowMs: now(options),
        state: options.state,
      }),
  };

  try {
    const result = await options.run(workerContext);
    if (result.status === "yielded") {
      const continuationMarked = await requestConversationContinuation({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        state: options.state,
      });
      if (!continuationMarked) {
        return { status: "lost_lease" };
      }
      await sendWakeNudge({
        conversationId,
        idempotencyKey: nudgeIdempotencyKey("yield", conversationId),
        nowMs: now(options),
        options,
      });
      await releaseConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        state: options.state,
      });
      logInfo(
        "conversation_work_cooperative_yield",
        { conversationId },
        {
          "app.worker.elapsed_ms": now(options) - startedAtMs,
          "app.worker.soft_yield_deadline_ms": softYieldDeadlineMs,
        },
        "Conversation work yielded cooperatively",
      );
      return { status: "yielded" };
    }

    const completion = await completeConversationWork({
      conversationId,
      leaseToken: lease.leaseToken,
      nowMs: now(options),
      state: options.state,
    });
    if (completion === "lost_lease") {
      return { status: "lost_lease" };
    }
    if (completion === "pending") {
      await sendWakeNudge({
        conversationId,
        idempotencyKey: nudgeIdempotencyKey("pending", conversationId),
        nowMs: now(options),
        options,
      });
      return { status: "pending_requeued" };
    }

    logInfo(
      "conversation_work_completed",
      { conversationId },
      {
        "app.worker.elapsed_ms": now(options) - startedAtMs,
      },
      "Conversation work completed",
    );
    return { status: "completed" };
  } catch (error) {
    try {
      await requestConversationContinuation({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        state: options.state,
      });
      await releaseConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        state: options.state,
      });
    } catch (releaseError) {
      logException(
        releaseError,
        "conversation_work_release_failed",
        { conversationId },
        {},
        "Conversation work release failed after runner error",
      );
    }
    logException(
      error,
      "conversation_work_failed",
      { conversationId },
      {
        "app.worker.elapsed_ms": now(options) - startedAtMs,
      },
      "Conversation work failed",
    );
    throw error;
  } finally {
    clearInterval(timer);
  }
}
