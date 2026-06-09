import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { sameDestination } from "@/chat/destination";
import { logException, logInfo, logWarn } from "@/chat/logging";
import { isProviderRetryError } from "@/chat/services/provider-retry";
import {
  ConversationQueueMessageRejectedError,
  type ConversationQueueMessage,
  type ConversationWorkQueue,
} from "./queue";
import {
  checkInConversationWork,
  completeConversationWork,
  CONVERSATION_WORK_CHECK_IN_INTERVAL_MS,
  CONVERSATION_WORK_MAX_CONSECUTIVE_FAILURES,
  countPendingConversationMessages,
  drainConversationMailbox,
  getConversationWorkState,
  markConversationWorkEnqueued,
  recordConversationWorkFailure,
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
  destination: Destination;
  drainMailbox(
    inject: (messages: InboundMessageRecord[]) => Promise<void>,
  ): Promise<InboundMessageRecord[]>;
  leaseToken: string;
  shouldYield(): boolean;
}

export interface ConversationWorkerResult {
  status: "completed" | "lost_lease" | "yielded";
}

export interface ConversationWorkProcessResult {
  status:
    | "abandoned"
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

function nudgeIdempotencyKey(
  reason: string,
  conversationId: string,
  nowMs: number,
): string {
  return `${reason}:${conversationId}:${nowMs}`;
}

async function sendWakeNudge(args: {
  conversationId: string;
  destination: Destination;
  delayMs?: number;
  idempotencyKey: string;
  nowMs: number;
  options: ProcessConversationWorkOptions;
}): Promise<void> {
  await args.options.queue.send(
    {
      conversationId: args.conversationId,
      destination: args.destination,
    },
    {
      delayMs: args.delayMs,
      idempotencyKey: args.idempotencyKey,
    },
  );
  try {
    await markConversationWorkEnqueued({
      conversationId: args.conversationId,
      nowMs: args.nowMs,
      state: args.options.state,
    });
  } catch (error) {
    logException(
      error,
      "conversation_work_enqueue_marker_failed",
      { conversationId: args.conversationId },
      {},
      "Conversation work enqueue marker failed after queue acceptance",
    );
  }
}

async function requestLostLeaseRecovery(args: {
  conversationId: string;
  destination: Destination;
  leaseToken: string;
  nowMs: number;
  options: ProcessConversationWorkOptions;
}): Promise<void> {
  const continuationMarked = await requestConversationContinuation({
    conversationId: args.conversationId,
    destination: args.destination,
    leaseToken: args.leaseToken,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (!continuationMarked) {
    return;
  }
  const released = await releaseConversationWork({
    conversationId: args.conversationId,
    leaseToken: args.leaseToken,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (!released) {
    return;
  }
  await sendWakeNudge({
    conversationId: args.conversationId,
    destination: args.destination,
    idempotencyKey: nudgeIdempotencyKey(
      "lost_lease",
      args.conversationId,
      args.nowMs,
    ),
    nowMs: args.nowMs,
    options: args.options,
  });
}

function startLeaseCheckIn(args: {
  conversationId: string;
  leaseToken: string;
  onLostLease: () => void;
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
          args.onLostLease();
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
  message: ConversationQueueMessage,
  options: ProcessConversationWorkOptions,
): Promise<ConversationWorkProcessResult> {
  const conversationId = message.conversationId;
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
  if (!sameDestination(initial.destination, message.destination)) {
    throw new ConversationQueueMessageRejectedError(
      "destination_mismatch",
      `Conversation work queue destination changed for ${conversationId}`,
      { conversationId },
    );
  }
  const destination = initial.destination;

  let lease: Awaited<ReturnType<typeof startConversationWork>>;
  try {
    lease = await startConversationWork({
      conversationId,
      nowMs: now(options),
      state: options.state,
    });
  } catch (error) {
    logException(
      error,
      "conversation_work_lease_acquire_failed",
      { conversationId },
      {},
      "Conversation work lease acquisition failed; heartbeat will recover",
    );
    return { status: "no_work" };
  }
  if (lease.status === "no_work") {
    return { status: "no_work" };
  }
  if (lease.status === "active") {
    const nudgeNowMs = now(options);
    try {
      await sendWakeNudge({
        conversationId,
        destination,
        delayMs: CONVERSATION_WORK_DEFER_DELAY_MS,
        idempotencyKey: nudgeIdempotencyKey(
          "active",
          conversationId,
          nudgeNowMs,
        ),
        nowMs: nudgeNowMs,
        options,
      });
    } catch (error) {
      logException(
        error,
        "conversation_work_active_nudge_failed",
        { conversationId },
        {},
        "Conversation work active-lease nudge failed; heartbeat will recover",
      );
    }
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
  let leaseLost = false;
  const markLeaseLost = (): void => {
    leaseLost = true;
  };
  const timer = startLeaseCheckIn({
    conversationId,
    leaseToken: lease.leaseToken,
    onLostLease: markLeaseLost,
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
    destination,
    leaseToken: lease.leaseToken,
    shouldYield: () => leaseLost || now(options) >= softYieldDeadlineMs,
    checkIn: async () => {
      const checkedIn = await checkInConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        state: options.state,
      });
      if (!checkedIn) {
        markLeaseLost();
      }
      return checkedIn;
    },
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
    if (result.status === "lost_lease") {
      await requestLostLeaseRecovery({
        conversationId,
        destination,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        options,
      });
      return { status: "lost_lease" };
    }
    if (leaseLost) {
      await requestLostLeaseRecovery({
        conversationId,
        destination,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        options,
      });
      return { status: "lost_lease" };
    }
    if (result.status === "yielded") {
      const yieldNowMs = now(options);
      const continuationMarked = await requestConversationContinuation({
        conversationId,
        destination,
        leaseToken: lease.leaseToken,
        nowMs: yieldNowMs,
        state: options.state,
      });
      if (!continuationMarked) {
        return { status: "lost_lease" };
      }
      await sendWakeNudge({
        conversationId,
        destination,
        idempotencyKey: nudgeIdempotencyKey(
          "yield",
          conversationId,
          yieldNowMs,
        ),
        nowMs: yieldNowMs,
        options,
      });
      await releaseConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: yieldNowMs,
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
      const nudgeNowMs = now(options);
      await sendWakeNudge({
        conversationId,
        destination,
        idempotencyKey: nudgeIdempotencyKey(
          "pending",
          conversationId,
          nudgeNowMs,
        ),
        nowMs: nudgeNowMs,
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
    const errorNowMs = now(options);
    let failure:
      | Awaited<ReturnType<typeof recordConversationWorkFailure>>
      | undefined;
    try {
      failure = await recordConversationWorkFailure({
        conversationId,
        nowMs: errorNowMs,
        state: options.state,
      });
    } catch (recordError) {
      logException(
        recordError,
        "conversation_work_failure_record_failed",
        { conversationId },
        {},
        "Conversation work failure counter update failed",
      );
    }

    if (!isProviderRetryError(error)) {
      logException(
        error,
        "conversation_work_failed",
        { conversationId },
        {
          "app.worker.consecutive_failure_count":
            failure?.consecutiveFailureCount ?? null,
          "app.worker.elapsed_ms": now(options) - startedAtMs,
        },
        "Conversation work failed",
      );
    }

    if (failure?.abandoned) {
      logWarn(
        "conversation_work_abandoned",
        { conversationId },
        {
          "app.worker.consecutive_failure_count":
            failure.consecutiveFailureCount,
          "app.worker.max_consecutive_failures":
            CONVERSATION_WORK_MAX_CONSECUTIVE_FAILURES,
        },
        "Conversation work abandoned after repeated failures; stopping retries",
      );
      if (!failure.releasedLease) {
        try {
          await releaseConversationWork({
            conversationId,
            leaseToken: lease.leaseToken,
            nowMs: errorNowMs,
            state: options.state,
          });
        } catch (releaseError) {
          logException(
            releaseError,
            "conversation_work_release_failed",
            { conversationId },
            {},
            "Conversation work release failed after abandoning",
          );
        }
      }
      return { status: "abandoned" };
    }

    let requeueSucceeded = false;
    if (failure) {
      try {
        const continuationMarked = await requestConversationContinuation({
          conversationId,
          destination,
          leaseToken: lease.leaseToken,
          nowMs: errorNowMs,
          state: options.state,
        });
        if (continuationMarked) {
          await sendWakeNudge({
            conversationId,
            destination,
            idempotencyKey: nudgeIdempotencyKey(
              "error",
              conversationId,
              errorNowMs,
            ),
            nowMs: errorNowMs,
            options,
          });
          requeueSucceeded = true;
        }
      } catch (requeueError) {
        logException(
          requeueError,
          "conversation_work_requeue_failed",
          { conversationId },
          {},
          "Conversation work requeue failed after runner error",
        );
      }
    }
    try {
      await releaseConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: errorNowMs,
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

    if (requeueSucceeded) {
      return { status: "pending_requeued" };
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}
