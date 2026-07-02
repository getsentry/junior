import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { sameDestination } from "@/chat/destination";
import { logException, logInfo, logWarn } from "@/chat/logging";
import type { ConversationStore } from "@/chat/conversations/store";
import { isProviderRetryError } from "@/chat/services/provider-retry";
import {
  ConversationQueueMessageRejectedError,
  type ConversationQueueMessage,
  type ConversationWorkQueue,
} from "./queue";
import {
  checkInConversationWork,
  clearConsumedConversationWake,
  completeConversationWork,
  CONVERSATION_WORK_CHECK_IN_INTERVAL_MS,
  countPendingConversationMessages,
  drainConversationMailbox,
  ensureConversationWake,
  failConversationWork,
  getConversationWorkState,
  isInvalidConversationRecordError,
  recordConversationWorkFailure,
  releaseConversationWork,
  requestConversationContinuation,
  startConversationWork,
  type ConversationWorkFailureRecord,
  type ConversationWorkState,
  type InboundMessage,
} from "./store";

export const CONVERSATION_WORK_DEFER_DELAY_MS = 15_000;
export const CONVERSATION_WORK_SOFT_YIELD_AFTER_MS = 240_000;

export interface ConversationWorkerContext {
  checkIn(): Promise<boolean>;
  conversationId: string;
  destination: Destination;
  drainMailbox(
    inject: (messages: InboundMessage[]) => Promise<readonly string[] | void>,
  ): Promise<InboundMessage[]>;
  leaseToken: string;
  shouldYield(): boolean;
}

export interface ConversationWorkerResult {
  status: "completed" | "lost_lease" | "yielded";
}

export interface ConversationWorkProcessResult {
  status:
    | "active"
    | "completed"
    | "failed"
    | "lost_lease"
    | "no_work"
    | "pending_requeued"
    | "yielded";
}

export interface ProcessConversationWorkOptions {
  checkInIntervalMs?: number;
  conversationStore?: ConversationStore;
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
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (!continuationMarked) {
    return;
  }
  const released = await releaseConversationWork({
    conversationId: args.conversationId,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (!released) {
    return;
  }
  await ensureConversationWake({
    conversationId: args.conversationId,
    conversationStore: args.options.conversationStore,
    idempotencyKey: nudgeIdempotencyKey(
      "lost_lease",
      args.conversationId,
      args.nowMs,
    ),
    nowMs: args.nowMs,
    queue: args.options.queue,
    replaceExistingWake: true,
    state: args.options.state,
  });
}

/**
 * Record one failed delivery attempt and surface consumed poison messages.
 *
 * Consumption is logged here so every poisoned message leaves a
 * `conversation_work_poisoned` trail with its terminal attempt count.
 */
async function recordFailedDeliveryAttempt(args: {
  conversationId: string;
  leaseToken: string;
  nowMs: number;
  offeredInboundMessageIds: string[];
  options: ProcessConversationWorkOptions;
}): Promise<ConversationWorkFailureRecord> {
  const failure = await recordConversationWorkFailure({
    conversationId: args.conversationId,
    inboundMessageIds: args.offeredInboundMessageIds,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  for (const message of failure.poisonedMessages) {
    logWarn(
      "conversation_work_poisoned",
      { conversationId: args.conversationId },
      {
        "app.conversation.source": message.source,
        "app.inbound.attempt_count": message.attemptCount ?? 0,
        "app.inbound.message_id": message.inboundMessageId,
        "app.inbound.pending_count": failure.pendingCount,
      },
      "Conversation work message consumed after exceeding the delivery attempt limit",
    );
  }
  return failure;
}

/** True only when this attempt poisoned messages and left no further pending work. */
function isTerminalFailure(failure: ConversationWorkFailureRecord): boolean {
  return (
    failure.status === "recorded" &&
    failure.poisonedMessages.length > 0 &&
    failure.pendingCount === 0
  );
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
      conversationStore: args.options.conversationStore,
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
  let initial: ConversationWorkState | undefined;
  try {
    initial = await getConversationWorkState({
      conversationId,
      state: options.state,
    });
  } catch (error) {
    // Redelivery cannot repair a permanently invalid record, so the delivery
    // is acknowledged as rejected instead of retried until retention expiry.
    if (isInvalidConversationRecordError(error)) {
      throw new ConversationQueueMessageRejectedError(
        "invalid_record",
        `Conversation record failed validation for ${conversationId}`,
        { conversationId },
      );
    }
    throw error;
  }
  if (
    !initial ||
    (countPendingConversationMessages(initial) === 0 &&
      initial.execution.status === "idle" &&
      !initial.execution.lease)
  ) {
    if (initial) {
      await clearConsumedConversationWake({
        conversationId,
        conversationStore: options.conversationStore,
        nowMs: now(options),
        state: options.state,
      });
    }
    return { status: "no_work" };
  }
  if (
    !initial.destination ||
    !sameDestination(initial.destination, message.destination)
  ) {
    throw new ConversationQueueMessageRejectedError(
      "destination_mismatch",
      `Conversation work queue destination changed for ${conversationId}`,
      { conversationId },
    );
  }
  const destination = initial.destination;

  const lease = await startConversationWork({
    conversationId,
    conversationStore: options.conversationStore,
    nowMs: now(options),
    state: options.state,
  });
  if (lease.status === "no_work") {
    await clearConsumedConversationWake({
      conversationId,
      conversationStore: options.conversationStore,
      nowMs: now(options),
      state: options.state,
    });
    return { status: "no_work" };
  }
  if (lease.status === "active") {
    const nudgeNowMs = now(options);
    await ensureConversationWake({
      conversationId,
      conversationStore: options.conversationStore,
      delayMs: CONVERSATION_WORK_DEFER_DELAY_MS,
      idempotencyKey: nudgeIdempotencyKey("active", conversationId, nudgeNowMs),
      nowMs: nudgeNowMs,
      queue: options.queue,
      replaceExistingWake: true,
      state: options.state,
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
  const offeredInboundMessageIds = initial.messages.map(
    (message) => message.inboundMessageId,
  );
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
        conversationStore: options.conversationStore,
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
        conversationStore: options.conversationStore,
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
        conversationStore: options.conversationStore,
        nowMs: yieldNowMs,
        state: options.state,
      });
      if (!continuationMarked) {
        return { status: "lost_lease" };
      }
      await ensureConversationWake({
        conversationId,
        conversationStore: options.conversationStore,
        idempotencyKey: nudgeIdempotencyKey(
          "yield",
          conversationId,
          yieldNowMs,
        ),
        nowMs: yieldNowMs,
        queue: options.queue,
        state: options.state,
      });
      await releaseConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        conversationStore: options.conversationStore,
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

    // A run that returns without durably handling any offered message is a
    // failed delivery attempt, even when the runner swallowed its error:
    // completing would requeue the untouched mailbox forever.
    if (offeredInboundMessageIds.length > 0) {
      const failure = await recordFailedDeliveryAttempt({
        conversationId,
        leaseToken: lease.leaseToken,
        nowMs: now(options),
        offeredInboundMessageIds,
        options,
      });
      if (isTerminalFailure(failure)) {
        await failConversationWork({
          conversationId,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: now(options),
          state: options.state,
        });
        return { status: "failed" };
      }
    }

    const completion = await completeConversationWork({
      conversationId,
      leaseToken: lease.leaseToken,
      conversationStore: options.conversationStore,
      nowMs: now(options),
      state: options.state,
    });
    if (completion === "lost_lease") {
      return { status: "lost_lease" };
    }
    if (completion === "pending") {
      const nudgeNowMs = now(options);
      const wake = await ensureConversationWake({
        conversationId,
        conversationStore: options.conversationStore,
        idempotencyKey: nudgeIdempotencyKey(
          "pending",
          conversationId,
          nudgeNowMs,
        ),
        nowMs: nudgeNowMs,
        queue: options.queue,
        state: options.state,
      });
      return wake.status === "enqueued"
        ? { status: "pending_requeued" }
        : { status: "completed" };
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
    // A failed run must not both NACK the queue delivery and schedule a
    // recovery nudge. Once durable recovery state is recorded and one nudge is
    // sent, the delivery is acknowledged; only when recording recovery state
    // itself fails is the error rethrown so plain redelivery retries it.
    let recoveryRecorded = false;
    try {
      const failure =
        offeredInboundMessageIds.length > 0
          ? await recordFailedDeliveryAttempt({
              conversationId,
              leaseToken: lease.leaseToken,
              nowMs: errorNowMs,
              offeredInboundMessageIds,
              options,
            })
          : undefined;
      if (failure && isTerminalFailure(failure)) {
        await failConversationWork({
          conversationId,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: errorNowMs,
          state: options.state,
        });
      } else {
        const continuationMarked = await requestConversationContinuation({
          conversationId,
          destination,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: errorNowMs,
          state: options.state,
        });
        if (continuationMarked) {
          await ensureConversationWake({
            conversationId,
            conversationStore: options.conversationStore,
            idempotencyKey: nudgeIdempotencyKey(
              "error",
              conversationId,
              errorNowMs,
            ),
            nowMs: errorNowMs,
            queue: options.queue,
            state: options.state,
          });
        }
        await releaseConversationWork({
          conversationId,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: errorNowMs,
          state: options.state,
        });
      }
      recoveryRecorded = true;
    } catch (recoveryError) {
      logException(
        recoveryError,
        "conversation_work_requeue_failed",
        { conversationId },
        {},
        "Conversation work recovery failed after runner error",
      );
    }
    if (!isProviderRetryError(error)) {
      logException(
        error,
        "conversation_work_failed",
        { conversationId },
        {
          "app.worker.elapsed_ms": now(options) - startedAtMs,
        },
        "Conversation work failed",
      );
    }
    if (!recoveryRecorded) {
      throw error;
    }
    return { status: "failed" };
  } finally {
    clearInterval(timer);
  }
}
