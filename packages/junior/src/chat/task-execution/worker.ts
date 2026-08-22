import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { getChatConfig } from "@/chat/config";
import { logException, logInfo, logWarn, withLogContext } from "@/chat/logging";
import type { ConversationStore } from "@/chat/conversations/store";
import { isProviderRetryError } from "@/chat/services/provider-error";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import {
  ConversationQueueMessageRejectedError,
  type ConversationQueueMessage,
  type ConversationWorkQueue,
} from "./queue";
import {
  ackMessages,
  beginConversationResume,
  checkInConversationWork,
  clearConsumedConversationWake,
  completeConversationStop,
  completeConversationWork,
  CONVERSATION_WORK_CHECK_IN_INTERVAL_MS,
  CONVERSATION_WORK_MAX_RETRIES,
  countPendingConversationMessages,
  deadLetterAttempt,
  drainConversationMailbox,
  ensureConversationWake,
  getConversationWorkState,
  isFinalAttempt,
  isInvalidConversationRecordError,
  recordAttemptFailure,
  recordConversationRetry,
  releaseConversationWork,
  requestAnotherSlice,
  startConversationWork,
  type AttemptFailure,
  type ConversationWorkState,
  type InboundMessage,
} from "./store";

export const CONVERSATION_WORK_DEFER_DELAY_MS = 15_000;
const CONVERSATION_STOP_CHECK_INTERVAL_MS = 500;

export interface ConversationWorkerContext {
  attempt: InboxAttempt;
  checkIn(): Promise<boolean>;
  conversationId: string;
  destination?: Destination;
  publishExternally: boolean;
  /** True when the current execution slice must stop at its next safe boundary. */
  shouldYield(): boolean;
  /** Return an AbortSignal backed by the durable Conversation stop request. */
  stopSignal?(): AbortSignal;
}

export interface InboxAttempt {
  ack(): Promise<void>;
  conversationId: string;
  destination?: Destination;
  drain(
    handle: (messages: InboundMessage[]) => Promise<readonly string[] | void>,
  ): Promise<InboundMessage[]>;
  isFinalAttempt: boolean;
  messages: InboundMessage[];
}

export interface ConversationWorkerResult {
  /** `paused` waits for an external wake but must resume if a stop raced it. */
  status: "completed" | "deferred" | "lost_lease" | "paused" | "yielded";
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

function selectContiguousTurnBatch(
  messages: readonly InboundMessage[],
): InboundMessage[] {
  const first = messages[0];
  if (!first) {
    return [];
  }
  const nextTurnIndex = messages.findIndex(
    (message) =>
      message.input.authorId !== first.input.authorId ||
      message.publishExternally !== first.publishExternally,
  );
  return messages.slice(
    0,
    nextTurnIndex === -1 ? messages.length : nextTurnIndex,
  );
}

/** Prioritize interrupts while keeping each attempt scoped to one actor. */
function selectAttemptMessages(work: ConversationWorkState): InboundMessage[] {
  const messages = work.messages;
  const interrupts = messages.filter(
    (message) => message.delivery === "interrupt",
  );
  if (interrupts.length > 0) {
    return selectContiguousTurnBatch(interrupts);
  }
  return work.execution.status === "paused"
    ? []
    : selectContiguousTurnBatch(messages);
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
  destination?: Destination;
  leaseToken: string;
  nowMs: number;
  options: ProcessConversationWorkOptions;
}): Promise<void> {
  const before = await getConversationWorkState({
    conversationId: args.conversationId,
    state: args.options.state,
  });
  const retry = await recordConversationRetry({
    conversationId: args.conversationId,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (retry === "lost_lease") {
    return;
  }
  if (retry === "stopped") {
    logException(
      new Error("Conversation work stopped after repeated failed attempts"),
      "conversation.work.retry.exhausted",
      {
        "app.run.id": before?.execution.runId ?? "unknown",
        "app.worker.last_progress_at_ms":
          before?.execution.lastProgressAtMs ?? before?.createdAtMs ?? 0,
        "app.worker.retry_count": (before?.execution.retryCount ?? 0) + 1,
      },
    );
    return;
  }
  const sliceRequested = await requestAnotherSlice({
    conversationId: args.conversationId,
    destination: args.destination,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  if (!sliceRequested) {
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
 * Record one failed delivery attempt and surface dead-lettered messages.
 *
 * Consumption is logged here so every dead-lettered message leaves a
 * `conversation.work.dead_lettered` trail with its terminal attempt count.
 */
async function recordFailedDeliveryAttempt(args: {
  conversationId: string;
  leaseToken: string;
  nowMs: number;
  messageIds: string[];
  options: ProcessConversationWorkOptions;
}): Promise<AttemptFailure> {
  const failure = await recordAttemptFailure({
    conversationId: args.conversationId,
    inboundMessageIds: args.messageIds,
    leaseToken: args.leaseToken,
    conversationStore: args.options.conversationStore,
    nowMs: args.nowMs,
    state: args.options.state,
  });
  for (const message of failure.deadLetteredMessages) {
    logWarn("conversation.work.dead_lettered", {
      "app.conversation.source": message.source,
      "app.inbound.attempt_count": message.attemptCount ?? 0,
      "app.inbound.message_id": message.inboundMessageId,
      "app.inbound.pending_count": failure.pendingCount,
    });
  }
  return failure;
}

/** True only when this attempt dead-lettered messages and left no further pending work. */
function isTerminalFailure(failure: AttemptFailure): boolean {
  return (
    failure.status === "recorded" &&
    failure.deadLetteredMessages.length > 0 &&
    failure.pendingCount === 0
  );
}

function logRetryExhausted(args: {
  error: unknown;
  retryCount: number;
  work: ConversationWorkState;
}): void {
  logException(args.error, "conversation.work.retry.exhausted", {
    "app.run.id": args.work.execution.runId ?? "unknown",
    "app.worker.last_progress_at_ms":
      args.work.execution.lastProgressAtMs ?? args.work.createdAtMs,
    "app.worker.retry_count": args.retryCount,
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
      conversationStore: args.options.conversationStore,
      nowMs,
      state: args.options.state,
    }).then(
      (checkedIn) => {
        if (!checkedIn) {
          args.onLostLease();
          logWarn("conversation.work.check_in.failed");
        }
      },
      (error) => {
        logException(error, "conversation.work.check_in.failed");
      },
    );
  }, args.options.checkInIntervalMs ?? CONVERSATION_WORK_CHECK_IN_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Poll shared state only when a worker adapter asks to observe remote stops. */
function createConversationStopSignal(args: {
  conversationId: string;
  initialStopRunId?: string;
  options: ProcessConversationWorkOptions;
  runId: string;
}) {
  const controller = new AbortController();
  let checking = false;
  let failureCaptured = false;
  let listening = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const requestStop = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("Conversation work stopped"));
    }
  };
  if (args.initialStopRunId === args.runId) {
    requestStop();
  }

  const check = async (): Promise<void> => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const current = await getConversationWorkState({
        conversationId: args.conversationId,
        state: args.options.state,
      });
      if (current?.execution.stop?.runId === args.runId) {
        requestStop();
      }
    } catch (error) {
      if (!failureCaptured) {
        failureCaptured = true;
        logException(error, "conversation.work.stop_check.failed");
      }
    } finally {
      checking = false;
    }
  };

  return {
    close(): void {
      if (timer) clearInterval(timer);
    },
    isEnabled(): boolean {
      return listening;
    },
    wasObserved(): boolean {
      return listening && controller.signal.aborted;
    },
    signal(): AbortSignal {
      listening = true;
      if (!timer && !controller.signal.aborted) {
        timer = setInterval(
          () => void check(),
          CONVERSATION_STOP_CHECK_INTERVAL_MS,
        );
        timer.unref?.();
      }
      return controller.signal;
    },
  };
}

/** Process one queue wake-up for a conversation. */
export async function processConversationWork(
  message: ConversationQueueMessage,
  options: ProcessConversationWorkOptions,
): Promise<ConversationWorkProcessResult> {
  return withLogContext({ conversationId: message.conversationId }, () =>
    processConversationWorkInContext(message, options),
  );
}

async function processConversationWorkInContext(
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
    logInfo("conversation.work.nudge.deferred", {
      "app.lease.expires_at_ms": lease.leaseExpiresAtMs,
    });
    return { status: "active" };
  }

  const startedAtMs = now(options);
  const softYieldDeadlineMs =
    startedAtMs +
    (options.softYieldAfterMs ??
      getChatConfig().conversationWorkSoftYieldAfterMs);
  let attemptMessageIds: string[] = [];
  let attemptSelectedMessageIds = new Set<string>();
  let attemptStartMessageIds = new Set<string>();
  let failedWithoutProgress = false;
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
  logInfo("conversation.work.lease.acquired", {
    "app.lease.expires_at_ms": lease.leaseExpiresAtMs,
    "app.worker.soft_yield_deadline_ms": softYieldDeadlineMs,
  });

  const drain = (
    handle: (messages: InboundMessage[]) => Promise<readonly string[] | void>,
  ) =>
    drainConversationMailbox({
      conversationId,
      leaseToken: lease.leaseToken,
      conversationStore: options.conversationStore,
      handle: async (messages) => {
        // Pending work that was not selected when the attempt started belongs
        // to a later actor-scoped attempt. Selected or newly arrived
        // interrupts remain eligible for this attempt's drain.
        const candidates = messages.filter(
          (message) =>
            message.delivery === "interrupt" &&
            (attemptSelectedMessageIds.has(message.inboundMessageId) ||
              !attemptStartMessageIds.has(message.inboundMessageId)),
        );
        if (candidates.length === 0) {
          return [];
        }
        return (
          (await handle(candidates)) ??
          candidates.map((message) => message.inboundMessageId)
        );
      },
      nowMs: now(options),
      state: options.state,
    });

  const requestDeadlineAtMs = getTurnRequestDeadline()?.deadlineAtMs;
  const shouldYield = (): boolean =>
    // Lease ownership is no longer confirmed, so this worker must stop.
    leaseLost ||
    // The worker soft limit reserves time to persist state and release the lease.
    now(options) >= softYieldDeadlineMs ||
    // Nested work can inherit an older host request deadline. Stop after that
    // absolute deadline, even if this worker acquired its lease later.
    (requestDeadlineAtMs !== undefined && Date.now() >= requestDeadlineAtMs);
  const checkIn = async (): Promise<boolean> => {
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
  };
  const yieldWork = async (): Promise<ConversationWorkProcessResult> => {
    const yieldNowMs = now(options);
    await ensureConversationWake({
      conversationId,
      conversationStore: options.conversationStore,
      idempotencyKey: nudgeIdempotencyKey("yield", conversationId, yieldNowMs),
      nowMs: yieldNowMs,
      queue: options.queue,
      replaceExistingWake: true,
      state: options.state,
    });
    const released = await releaseConversationWork({
      conversationId,
      leaseToken: lease.leaseToken,
      conversationStore: options.conversationStore,
      nowMs: yieldNowMs,
      state: options.state,
    });
    if (!released) {
      return { status: "lost_lease" };
    }
    logInfo("conversation.work.yielded", {
      "app.worker.elapsed_ms": now(options) - startedAtMs,
      "app.worker.soft_yield_deadline_ms": softYieldDeadlineMs,
    });
    return { status: "yielded" };
  };

  try {
    let hasRun = false;
    let resumeIfStopped = false;
    while (true) {
      attemptMessageIds = [];
      const leasedWork = await getConversationWorkState({
        conversationId,
        state: options.state,
      });
      if (
        !leasedWork ||
        leasedWork.lease?.leaseToken !== lease.leaseToken ||
        leaseLost
      ) {
        markLeaseLost();
        await requestLostLeaseRecovery({
          conversationId,
          destination,
          leaseToken: lease.leaseToken,
          nowMs: now(options),
          options,
        });
        return { status: "lost_lease" };
      }

      const resumePending = leasedWork.execution.status === "paused";
      const attemptMessages = selectAttemptMessages(leasedWork);
      const runId = leasedWork.execution.runId;
      if (!runId) {
        throw new Error(`Conversation run is missing for ${conversationId}`);
      }
      attemptStartMessageIds = new Set(
        leasedWork.messages.map((message) => message.inboundMessageId),
      );

      if (hasRun && shouldYield()) {
        if (resumePending) {
          return await yieldWork();
        }
        break;
      }

      if (resumePending && attemptMessages.length === 0) {
        const resumeStarted = await beginConversationResume({
          conversationId,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: now(options),
          state: options.state,
        });
        if (!resumeStarted) {
          markLeaseLost();
          await requestLostLeaseRecovery({
            conversationId,
            destination,
            leaseToken: lease.leaseToken,
            nowMs: now(options),
            options,
          });
          return { status: "lost_lease" };
        }
      }

      attemptMessageIds = attemptMessages.map(
        (message) => message.inboundMessageId,
      );
      // Empty batches are resume-only. Adapters read the checkpoint flag; do
      // not invent publish from destination presence.
      const publishExternally = attemptMessages[0]?.publishExternally ?? false;
      attemptSelectedMessageIds = new Set(attemptMessageIds);
      const ack = async (): Promise<void> => {
        const acknowledged = await ackMessages({
          conversationId,
          inboundMessageIds: attemptMessageIds,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: now(options),
          state: options.state,
        });
        if (!acknowledged) {
          markLeaseLost();
          throw new Error(
            `Conversation work lease lost before inbox ack for ${conversationId}`,
          );
        }
      };
      const stop = createConversationStopSignal({
        conversationId,
        initialStopRunId: leasedWork.execution.stop?.runId,
        options,
        runId,
      });
      const workerContext: ConversationWorkerContext = {
        attempt: {
          ack,
          conversationId,
          destination,
          drain,
          isFinalAttempt: attemptMessages.some((message) =>
            isFinalAttempt(message),
          ),
          messages: attemptMessages,
        },
        conversationId,
        destination,
        publishExternally,
        shouldYield,
        stopSignal: stop.signal,
        checkIn,
      };

      let result: ConversationWorkerResult;
      try {
        result = await options.run(workerContext);
      } finally {
        stop.close();
      }
      resumeIfStopped ||= stop.isEnabled();
      hasRun = true;
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
      if (result.status === "completed" && stop.wasObserved()) {
        const stopped = await completeConversationStop({
          conversationId,
          conversationStore: options.conversationStore,
          leaseToken: lease.leaseToken,
          nowMs: now(options),
          runId,
          state: options.state,
        });
        if (stopped.status === "lost_lease") {
          markLeaseLost();
          await requestLostLeaseRecovery({
            conversationId,
            destination,
            leaseToken: lease.leaseToken,
            nowMs: now(options),
            options,
          });
          return { status: "lost_lease" };
        }
      }
      if (result.status === "yielded") {
        const sliceRequested = await requestAnotherSlice({
          conversationId,
          destination,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: now(options),
          state: options.state,
        });
        if (!sliceRequested) {
          return { status: "lost_lease" };
        }
        return await yieldWork();
      }

      if (result.status === "deferred") {
        const deferredNowMs = now(options);
        const released = await releaseConversationWork({
          conversationId,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: deferredNowMs,
          state: options.state,
        });
        if (!released) {
          return { status: "lost_lease" };
        }
        const wake = await ensureConversationWake({
          conversationId,
          conversationStore: options.conversationStore,
          idempotencyKey: nudgeIdempotencyKey(
            "deferred",
            conversationId,
            deferredNowMs,
          ),
          nowMs: deferredNowMs,
          queue: options.queue,
          state: options.state,
        });
        return wake.status === "enqueued"
          ? { status: "pending_requeued" }
          : { status: "completed" };
      }

      // A run that returns without durably handling any attempted message is a
      // failed delivery attempt, even when the runner swallowed its error.
      if (attemptMessageIds.length > 0) {
        const failure = await recordFailedDeliveryAttempt({
          conversationId,
          leaseToken: lease.leaseToken,
          nowMs: now(options),
          messageIds: attemptMessageIds,
          options,
        });
        if (isTerminalFailure(failure)) {
          if (failure.retryCount >= CONVERSATION_WORK_MAX_RETRIES) {
            logRetryExhausted({
              error: new Error(
                "Conversation work stopped after repeated failed attempts",
              ),
              retryCount: failure.retryCount,
              work: leasedWork,
            });
          }
          await deadLetterAttempt({
            conversationId,
            leaseToken: lease.leaseToken,
            conversationStore: options.conversationStore,
            nowMs: now(options),
            state: options.state,
          });
          return { status: "failed" };
        }
        if (failure.status === "lost_lease") {
          return { status: "lost_lease" };
        }
        if (failure.status === "recorded") {
          failedWithoutProgress = true;
          break;
        }
      }

      if (result.status === "paused") {
        break;
      }

      const next = await getConversationWorkState({
        conversationId,
        state: options.state,
      });
      if (!next || next.lease?.leaseToken !== lease.leaseToken) {
        return { status: "lost_lease" };
      }
      if (
        next.execution.status !== "paused" &&
        countPendingConversationMessages(next) === 0
      ) {
        break;
      }
    }

    const completion = await completeConversationWork({
      conversationId,
      leaseToken: lease.leaseToken,
      madeProgress: !failedWithoutProgress,
      // A stop that raced an external pause must reach the paused Turn.
      resumeIfStopped,
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

    logInfo("conversation.work.completed", {
      "app.worker.elapsed_ms": now(options) - startedAtMs,
    });
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
        attemptMessageIds.length > 0
          ? await recordFailedDeliveryAttempt({
              conversationId,
              leaseToken: lease.leaseToken,
              nowMs: errorNowMs,
              messageIds: attemptMessageIds,
              options,
            })
          : undefined;
      if (failure && isTerminalFailure(failure)) {
        if (failure.retryCount >= CONVERSATION_WORK_MAX_RETRIES) {
          logRetryExhausted({
            error,
            retryCount: failure.retryCount,
            work: initial,
          });
        }
        await deadLetterAttempt({
          conversationId,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: errorNowMs,
          state: options.state,
        });
      } else if (failure?.status === "recorded") {
        await releaseConversationWork({
          conversationId,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: errorNowMs,
          state: options.state,
        });
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
          replaceExistingWake: true,
          state: options.state,
        });
      } else {
        const retry = failure
          ? failure.status
          : await recordConversationRetry({
              conversationId,
              leaseToken: lease.leaseToken,
              conversationStore: options.conversationStore,
              nowMs: errorNowMs,
              state: options.state,
            });
        if (retry === "stopped") {
          logException(error, "conversation.work.retry.exhausted", {
            "app.run.id": initial.execution.runId ?? "unknown",
            "app.worker.last_progress_at_ms":
              initial.execution.lastProgressAtMs ?? initial.createdAtMs,
            "app.worker.retry_count":
              failure?.retryCount ?? (initial.execution.retryCount ?? 0) + 1,
          });
          recoveryRecorded = true;
          return { status: "failed" };
        }
        const sliceRequested = await requestAnotherSlice({
          conversationId,
          destination,
          leaseToken: lease.leaseToken,
          conversationStore: options.conversationStore,
          nowMs: errorNowMs,
          state: options.state,
        });
        if (sliceRequested) {
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
            replaceExistingWake: true,
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
      logException(recoveryError, "conversation.work.requeue.failed");
    }
    if (!isProviderRetryError(error)) {
      logException(error, "conversation.work.failed", {
        "app.worker.elapsed_ms": now(options) - startedAtMs,
      });
    }
    if (!recoveryRecorded) {
      throw error;
    }
    return { status: "failed" };
  } finally {
    clearInterval(timer);
  }
}
