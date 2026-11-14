import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import { getConversationStore } from "@/chat/db";
import { logException } from "@/chat/logging";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  CONVERSATION_QUEUE_SCHEMA_VERSION,
  type ConversationWorkQueue,
} from "./queue";
import * as workState from "./state";

export type { BeforeWorkStops, RenderInboundText } from "./state";
export {
  CONVERSATION_ACTIVE_INDEX_KEY,
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  CONVERSATION_WORK_CHECK_IN_INTERVAL_MS,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS,
  CONVERSATION_WORK_MAX_RETRIES,
  CONVERSATION_WORK_STALE_ENQUEUE_MS,
  countPendingConversationMessages,
  deferConversationMove,
  hasConversationStop,
  hasRunnableConversationWork,
  isFinalAttempt,
  isInvalidConversationRecordError,
  moveIdleConversationDestination,
  pruneActiveConversation,
  releaseInboundMessage,
  type AgentInput,
  type AttemptFailure,
  type AppendAndEnqueueInboundMessageResult,
  type AppendInboundMessageResult,
  type CompleteConversationStopResult,
  type ConversationExecutionState,
  type ConversationExecution,
  type ConversationStop,
  type ConversationWorkLease,
  type ConversationWorkState,
  type ExecutionStatus,
  type InboundMessage,
  type InboundMessageDelivery,
  type Lease,
  type RequestConversationWorkResult,
  type Source,
  type StartConversationWorkAcquired,
  type StartConversationWorkActive,
  type StartConversationWorkNoWork,
  type StartConversationWorkResult,
  type StopConversationWorkResult,
} from "@/chat/task-execution/state";
import type {
  AppendAndEnqueueExclusiveInboundMessageResult,
  AppendAndEnqueueInboundMessageResult,
  AppendExclusiveInboundMessageResult,
  ConversationExecutionState,
  InboundMessage,
} from "@/chat/task-execution/state";
import {
  CONVERSATION_WORK_STALE_ENQUEUE_MS,
  hasRunnableConversationWork,
} from "@/chat/task-execution/state";

interface MetadataOptions {
  conversationStore?: ConversationStore | undefined;
  state?: StateAdapter | undefined;
}

export type EnsureConversationWakeResult =
  | {
      queueMessageId?: string | undefined;
      status: "enqueued";
    }
  | {
      status: "already_enqueued" | "lease_active" | "no_work";
    };

function metadataStore(options: MetadataOptions): ConversationStore {
  return options.conversationStore ?? getConversationStore();
}

function duplicateInboundNudgeIdempotencyKey(
  message: InboundMessage,
  nowMs: number,
): string {
  return `duplicate:${message.conversationId}:${message.inboundMessageId}:${nowMs}`;
}

function hasRecentEnqueueMarker(
  conversation: ConversationExecutionState,
  nowMs: number,
): boolean {
  const lastEnqueuedAtMs = conversation.execution.lastEnqueuedAtMs;
  return (
    typeof lastEnqueuedAtMs === "number" &&
    lastEnqueuedAtMs + CONVERSATION_WORK_STALE_ENQUEUE_MS > nowMs
  );
}

function now(): number {
  return Date.now();
}

async function recordExecutionMetadata(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  state?: StateAdapter | undefined;
}): Promise<void> {
  const conversation = await workState.getConversation({
    conversationId: args.conversationId,
    state: args.state,
  });
  if (!conversation) {
    return;
  }
  await metadataStore(args).recordExecution({
    channelName: conversation.channelName,
    conversationId: conversation.conversationId,
    createdAtMs: conversation.createdAtMs,
    destination: conversation.destination,
    execution: {
      lastCheckpointAtMs: conversation.execution.lastCheckpointAtMs,
      lastEnqueuedAtMs: conversation.execution.lastEnqueuedAtMs,
      runId: conversation.execution.runId,
      status: conversation.execution.status,
      updatedAtMs: conversation.execution.updatedAtMs,
    },
    lastActivityAtMs: conversation.lastActivityAtMs,
    metrics: null,
    actor: conversation.actor,
    source: conversation.source,
    title: conversation.title,
    updatedAtMs: conversation.updatedAtMs,
  });
}

/** Return a persisted conversation record, if one exists. */
export async function getConversation(args: {
  conversationId: string;
  state?: StateAdapter;
}) {
  return await workState.getConversation(args);
}

/** Return a persisted conversation work record, if one exists. */
export async function getConversationWorkState(args: {
  conversationId: string;
  state?: StateAdapter | undefined;
}) {
  return await workState.getConversationWorkState(args);
}

/** Return the persisted work records of several Conversations in one read. */
export async function getConversationWorkStates(
  conversationIds: readonly string[],
) {
  return await workState.getConversationWorkStates(conversationIds);
}

/** Count one failed conversation execution and persist its terminal retry state. */
export async function recordConversationRetry(args: {
  beforeWorkStops?: workState.BeforeWorkStops | undefined;
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.recordConversationRetry(args);
  await recordExecutionMetadata(args);
  return result;
}

/**
 * Ensure runnable conversation work has one accepted queue wake-up nudge.
 *
 * Ordinary wakes coalesce on a recent accepted marker. A caller can ignore the
 * marker without replacing an active lease. Replacement is only for consumed
 * or known-stale deliveries where another queue nudge must exist.
 */
export async function ensureConversationWake(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  delayMs?: number | undefined;
  idempotencyKey: string;
  ignoreEnqueueMarker?: true | undefined;
  nowMs?: number;
  queue: ConversationWorkQueue;
  replaceExistingWake?: true | undefined;
  state?: StateAdapter | undefined;
}): Promise<EnsureConversationWakeResult> {
  const nowMs = args.nowMs ?? now();
  const conversation = await workState.getConversation({
    conversationId: args.conversationId,
    state: args.state,
  });
  if (!conversation || !hasRunnableConversationWork(conversation)) {
    return { status: "no_work" };
  }
  if (
    args.replaceExistingWake !== true &&
    conversation.execution.lease &&
    conversation.execution.lease.expiresAtMs > nowMs
  ) {
    return { status: "lease_active" };
  }
  if (
    args.ignoreEnqueueMarker !== true &&
    args.replaceExistingWake !== true &&
    hasRecentEnqueueMarker(conversation, nowMs)
  ) {
    return { status: "already_enqueued" };
  }

  const queueResult = await args.queue.send(
    {
      schemaVersion: CONVERSATION_QUEUE_SCHEMA_VERSION,
      conversationId: args.conversationId,
    },
    {
      delayMs: args.delayMs,
      idempotencyKey: args.idempotencyKey,
    },
  );
  await markConversationWorkEnqueued({
    conversationId: args.conversationId,
    conversationStore: args.conversationStore,
    nowMs,
    state: args.state,
  });
  return { status: "enqueued", queueMessageId: queueResult?.messageId };
}

/** Persist one inbound message idempotently in its conversation mailbox. */
export async function appendInboundMessage(args: {
  message: InboundMessage;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.appendInboundMessage(args);
  await recordExecutionMetadata({
    conversationId: args.message.conversationId,
    conversationStore: args.conversationStore,
    state: args.state,
  });
  return result;
}

/**
 * Record an inbound message id that skips the mailbox. When the claim is
 * saved but its metadata write fails, this releases the claim, so a
 * redelivery can claim it again.
 */
export async function claimInboundMessage(args: {
  message: workState.InboundMessageClaim;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.claimInboundMessage(args);
  if (result.status === "claimed") {
    try {
      await recordExecutionMetadata({
        conversationId: args.message.conversationId,
        conversationStore: args.conversationStore,
        state: args.state,
      });
    } catch (error) {
      await workState.releaseInboundMessage({
        message: args.message,
        state: args.state,
      });
      throw error;
    }
  }
  return result;
}

async function enqueueAfterAppend(args: {
  appendResult: AppendExclusiveInboundMessageResult;
  message: InboundMessage;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  queue: ConversationWorkQueue;
  queueDelayMs?: number;
  replaceExistingWake?: true;
  state?: StateAdapter | undefined;
}): Promise<AppendAndEnqueueExclusiveInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  const appendResult = args.appendResult;
  if (appendResult.status === "active") return appendResult;
  let idempotencyKey = args.message.inboundMessageId;
  if (appendResult.status === "duplicate") {
    const conversation = await workState.getConversation({
      conversationId: args.message.conversationId,
      state: args.state,
    });
    if (!conversation) {
      return appendResult;
    }
    if (hasRecentEnqueueMarker(conversation, nowMs)) {
      await recordExecutionMetadata({
        conversationId: args.message.conversationId,
        conversationStore: args.conversationStore,
        state: args.state,
      });
      return appendResult;
    }
    const duplicateStillPending = conversation.execution.pendingMessages.some(
      (message) => message.inboundMessageId === args.message.inboundMessageId,
    );
    if (!duplicateStillPending) {
      await recordExecutionMetadata({
        conversationId: args.message.conversationId,
        conversationStore: args.conversationStore,
        state: args.state,
      });
      return appendResult;
    }
    idempotencyKey = duplicateInboundNudgeIdempotencyKey(args.message, nowMs);
  }
  const wake = await ensureConversationWake({
    conversationId: args.message.conversationId,
    conversationStore: args.conversationStore,
    delayMs: args.queueDelayMs,
    idempotencyKey,
    // Human input must not wait out an event's queue delay. An active worker
    // still owns the mailbox, so do not replace its wake.
    ignoreEnqueueMarker: args.message.source === "event" ? undefined : true,
    nowMs,
    queue: args.queue,
    replaceExistingWake: args.replaceExistingWake,
    state: args.state,
  });
  if (wake.status !== "enqueued") {
    await recordExecutionMetadata({
      conversationId: args.message.conversationId,
      conversationStore: args.conversationStore,
      state: args.state,
    });
  }
  return {
    ...appendResult,
    ...(wake.status === "enqueued"
      ? { queueMessageId: wake.queueMessageId }
      : undefined),
  };
}

/** Persist inbound work and ensure a worker wake-up. */
export async function appendAndEnqueueInboundMessage(args: {
  message: InboundMessage;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  queue: ConversationWorkQueue;
  queueDelayMs?: number;
  /** Render the message text under the mailbox lock. */
  renderText?: workState.RenderInboundText;
  replaceExistingWake?: true;
  state?: StateAdapter | undefined;
}): Promise<AppendAndEnqueueInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  const result = await enqueueAfterAppend({
    ...args,
    appendResult: await workState.appendInboundMessage({
      message: args.message,
      nowMs,
      renderText: args.renderText,
      state: args.state,
    }),
    nowMs,
  });
  if (result.status === "active") {
    throw new Error("Non-exclusive mailbox enqueue returned active");
  }
  return result;
}

/** Persist exclusive inbound work and wake its worker when admitted. */
export async function appendAndEnqueueExclusiveInboundMessage(args: {
  message: InboundMessage;
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  replaceExistingWake?: true;
  state?: StateAdapter;
}): Promise<AppendAndEnqueueExclusiveInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  return await enqueueAfterAppend({
    ...args,
    appendResult: await workState.appendExclusiveInboundMessage({
      message: args.message,
      nowMs,
      state: args.state,
    }),
    nowMs,
  });
}

/** Persist a stop request for the current Conversation run. */
export async function stopConversationWork(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  /** Runs once the stop request is saved, before its metadata write. */
  onStopSaved?: () => void;
  /** Stop only person input sent at or before this time. */
  sentAtOrBeforeMs?: number | undefined;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.stopConversationWork(args);
  if (result.status === "requested") {
    args.onStopSaved?.();
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Finish an observed stop request under the current worker lease. */
export async function completeConversationStop(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  leaseToken: string;
  nowMs?: number;
  runId: string;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.completeConversationStop(args);
  if (result.status === "cleared") {
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Clear an accepted wake marker after its delivery finds no runnable work. */
export async function clearConsumedConversationWake(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.clearConsumedConversationWake(args);
  if (result) {
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Mark a conversation runnable when there is no new mailbox message. */
export async function requestConversationWork(args: {
  conversationId: string;
  destination: InboundMessage["destination"];
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.requestConversationWork(args);
  await recordExecutionMetadata({
    conversationId: args.conversationId,
    conversationStore: args.conversationStore,
    state: args.state,
  });
  return result;
}

/** Record visible conversation activity without making the conversation runnable. */
export async function recordConversationActivity(
  args: Parameters<ConversationStore["recordActivity"]>[0] & {
    conversationStore?: ConversationStore;
    state?: StateAdapter;
  },
) {
  await workState.recordConversationActivity(args);
  await recordExecutionMetadata({
    conversationId: args.conversationId,
    conversationStore: args.conversationStore,
    state: args.state,
  });
}

/** Record that a wake-up nudge was accepted for the conversation. */
async function markConversationWorkEnqueued(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  await workState.markConversationWorkEnqueued(args);
  await recordExecutionMetadata(args);
}

/** Try to acquire the durable execution lease for one conversation. */
export async function startConversationWork(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.startConversationWork(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Extend the durable execution lease when the worker checks in. */
export async function checkInConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.checkInConversationWork(args);
  if (result) {
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Drain pending mailbox entries after the caller accepts responsibility. */
export async function drainConversationMailbox(
  args: Parameters<typeof workState.drainConversationMailbox>[0] & {
    conversationStore?: ConversationStore | undefined;
    state?: StateAdapter | undefined;
  },
) {
  const result = await workState.drainConversationMailbox(args);
  if (result.changed) {
    await recordExecutionMetadata(args);
  }
  return result.messages;
}

/** Acknowledge leased mailbox entries after the handler accepts responsibility. */
export async function ackMessages(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.ackMessages(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Cancel human-facing pending mailbox rows without requiring a worker lease. */
export async function cancelHumanFacingPendingMessages(args: {
  conversationId: string;
  inboundMessageIds?: readonly string[];
  receivedBeforeMs?: number;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.cancelHumanFacingPendingMessages(args);
  if (result.cancelledInboundMessageIds.length > 0) {
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Drop pending mailbox rows by id without requiring a worker lease. */
export async function dropPendingMessages(args: {
  conversationId: string;
  inboundMessageIds: readonly string[];
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const dropped = await workState.dropPendingMessages(args);
  if (dropped.length > 0) {
    await recordExecutionMetadata(args);
  }
  return dropped;
}

/** Mark one author's queued web messages as interrupts. */
export async function steerWebPendingMessages(args: {
  authorIds: readonly string[];
  conversationId: string;
  inboundMessageIds: readonly string[];
  nowMs?: number;
  state?: StateAdapter;
}) {
  // Delivery mode is not part of execution metadata, so there is nothing to record.
  return await workState.steerWebPendingMessages(args);
}

/** Mark the leased conversation as needing another queue-delivered slice. */
export async function requestAnotherSlice(args: {
  conversationId: string;
  destination: InboundMessage["destination"];
  leaseToken: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.requestAnotherSlice(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Begin a requested turn resume without releasing the current lease. */
export async function beginConversationResume(args: {
  conversationId: string;
  leaseToken: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.beginConversationResume(args);
  if (result) {
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Release the durable execution lease without changing completion state. */
export async function releaseConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.releaseConversationWork(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Finish a leased conversation and report whether runnable work remains. */
export async function completeConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  madeProgress?: boolean;
  conversationStore?: ConversationStore | undefined;
  /** Slack installation lookup for a move that waited for this Run. */
  getSlackAdapter?: (() => SlackAdapter) | undefined;
  nowMs?: number;
  /** Keep a raced stop runnable after a stop-aware adapter returns. */
  resumeIfStopped?: boolean;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.completeConversationWork(args);
  await recordExecutionMetadata(args);
  if (result !== "lost_lease") await runDeferredMove(args);
  return result;
}

/**
 * Run the Slack "Continue here" click that waited for this Run to end. Its
 * failure is logged here, so it never fails the Run that already finished.
 */
async function runDeferredMove(args: {
  conversationId: string;
  getSlackAdapter?: (() => SlackAdapter) | undefined;
  state?: StateAdapter | undefined;
}): Promise<void> {
  const move = await workState.takeDeferredConversationMove(args);
  if (move === undefined) return;
  try {
    // Load on first use: the Slack move imports this module.
    const { continueDeferredSlackClick } =
      await import("@/chat/ingress/slack-conversation-unfurl");
    await continueDeferredSlackClick(move, args.getSlackAdapter);
  } catch (error) {
    logException(error, "slack.continue_here.deferred.failed", {
      "gen_ai.conversation.id": args.conversationId,
    });
  }
}

/** Record one failed delivery attempt and dead-letter messages at their limit. */
export async function recordAttemptFailure(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.recordAttemptFailure(args);
  if (result.status === "recorded") {
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Record a terminal failure completion for a leased conversation. */
export async function deadLetterAttempt(args: {
  conversationId: string;
  leaseToken: string;
  conversationStore?: ConversationStore | undefined;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.deadLetterAttempt(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Recover an expired lease and persist the resulting retry state. */
export async function clearExpiredConversationLease(args: {
  beforeWorkStops?: workState.BeforeWorkStops | undefined;
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter | undefined;
}) {
  const result = await workState.clearExpiredConversationLease(args);
  await recordExecutionMetadata(args);
  return result;
}

/** List active conversation ids by oldest execution update first. */
export async function listActiveConversationIds(
  args: {
    limit?: number;
    staleBeforeMs?: number;
    state?: StateAdapter | undefined;
  } = {},
) {
  return await workState.listActiveConversationIds(args);
}

/** List retained conversations by newest visible activity first. */
export async function listConversationsByActivity(
  args: {
    limit?: number;
    state?: StateAdapter;
  } = {},
) {
  return await workState.listConversationsByActivity(args);
}
