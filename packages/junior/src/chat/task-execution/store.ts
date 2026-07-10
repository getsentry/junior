import type { StateAdapter } from "chat";
import { getConversationStore } from "@/chat/db";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "./queue";
import * as workState from "./state";
export {
  CONVERSATION_ACTIVE_INDEX_KEY,
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  CONVERSATION_WORK_CHECK_IN_INTERVAL_MS,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS,
  CONVERSATION_WORK_STALE_ENQUEUE_MS,
  isFinalAttempt,
  isInvalidConversationRecordError,
  type AgentInput,
  type AttemptFailure,
  type AppendAndEnqueueInboundMessageResult,
  type AppendInboundMessageResult,
  type Conversation,
  type ConversationExecution,
  type ConversationWorkLease,
  type ConversationWorkState,
  type ExecutionStatus,
  type InboundMessage,
  type Lease,
  type RequestConversationWorkResult,
  type Source,
  type StartConversationWorkAcquired,
  type StartConversationWorkActive,
  type StartConversationWorkNoWork,
  type StartConversationWorkResult,
} from "@/chat/task-execution/state";
import type {
  AppendAndEnqueueInboundMessageResult,
  Conversation,
  InboundMessage,
} from "@/chat/task-execution/state";
import { CONVERSATION_WORK_STALE_ENQUEUE_MS } from "@/chat/task-execution/state";

interface MetadataOptions {
  conversationStore?: ConversationStore;
  state?: StateAdapter;
}

export type EnsureConversationWakeResult =
  | {
      queueMessageId?: string;
      status: "enqueued";
    }
  | {
      status: "already_enqueued" | "no_work";
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
  conversation: Conversation,
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
  conversationStore?: ConversationStore;
  state?: StateAdapter;
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
  state?: StateAdapter;
}) {
  return await workState.getConversationWorkState(args);
}

/** Count mailbox messages that have not yet reached the session log. */
export function countPendingConversationMessages(
  conversation: Conversation,
): number {
  return conversation.execution.pendingMessages.length;
}

/** Return whether a conversation has pending or resumable execution work. */
export function hasRunnableConversationWork(
  conversation: Conversation,
): boolean {
  return (
    conversation.execution.status !== "idle" ||
    countPendingConversationMessages(conversation) > 0
  );
}

/**
 * Ensure runnable conversation work has one accepted queue wake-up nudge.
 *
 * Ordinary wakes coalesce on a recent accepted marker. Replacement is only for
 * consumed or known-stale deliveries where another queue nudge must exist.
 */
export async function ensureConversationWake(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  delayMs?: number;
  idempotencyKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  replaceExistingWake?: true;
  state?: StateAdapter;
}): Promise<EnsureConversationWakeResult> {
  const nowMs = args.nowMs ?? now();
  const conversation = await workState.getConversation({
    conversationId: args.conversationId,
    state: args.state,
  });
  if (!conversation || !hasRunnableConversationWork(conversation)) {
    return { status: "no_work" };
  }
  if (!conversation.destination) {
    return { status: "no_work" };
  }
  if (
    args.replaceExistingWake !== true &&
    hasRecentEnqueueMarker(conversation, nowMs)
  ) {
    return { status: "already_enqueued" };
  }

  const queueResult = await args.queue.send(
    {
      conversationId: args.conversationId,
      destination: conversation.destination,
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

/** Persist inbound work and ensure a worker wake-up. */
export async function appendAndEnqueueInboundMessage(args: {
  message: InboundMessage;
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<AppendAndEnqueueInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  const appendResult = await workState.appendInboundMessage({
    message: args.message,
    nowMs,
    state: args.state,
  });
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
    idempotencyKey,
    nowMs,
    queue: args.queue,
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
      : {}),
  };
}

/** Clear an accepted wake marker after its delivery finds no runnable work. */
export async function clearConsumedConversationWake(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
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
  state?: StateAdapter;
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
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  await workState.markConversationWorkEnqueued(args);
  await recordExecutionMetadata(args);
}

/** Try to acquire the durable execution lease for one conversation. */
export async function startConversationWork(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.startConversationWork(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Extend the durable execution lease when the worker checks in. */
export async function checkInConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
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
    conversationStore?: ConversationStore;
    state?: StateAdapter;
  },
) {
  const result = await workState.drainConversationMailbox(args);
  if (result.length > 0) {
    await recordExecutionMetadata(args);
  }
  return result;
}

/** Acknowledge leased mailbox entries after the handler accepts responsibility. */
export async function ackMessages(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.ackMessages(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Mark the leased conversation as needing another queue-delivered slice. */
export async function requestConversationContinuation(args: {
  conversationId: string;
  destination: InboundMessage["destination"];
  leaseToken: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.requestConversationContinuation(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Release the durable execution lease without changing completion state. */
export async function releaseConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.releaseConversationWork(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Finish a leased conversation and report whether runnable work remains. */
export async function completeConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.completeConversationWork(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Record one failed delivery attempt and dead-letter messages at their limit. */
export async function recordAttemptFailure(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
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
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.deadLetterAttempt(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Clear an expired durable lease so a later worker can resume safely. */
export async function clearExpiredConversationLease(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  const result = await workState.clearExpiredConversationLease(args);
  await recordExecutionMetadata(args);
  return result;
}

/** Remove one conversation from the active index after it is missing or idle. */
export async function removeActiveConversation(args: {
  conversationId: string;
  state?: StateAdapter;
}) {
  return await workState.removeActiveConversation(args);
}

/** List active conversation ids by oldest execution update first. */
export async function listActiveConversationIds(
  args: {
    limit?: number;
    staleBeforeMs?: number;
    state?: StateAdapter;
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
