import type { StateAdapter } from "chat";
import { createStateConversationMetadataStore } from "@/chat/metadata/state-store";
import {
  getConfiguredConversationMetadataStore,
  hasConfiguredJuniorDatabase,
} from "@/chat/metadata/configured-store";
import type { ConversationMetadataStore } from "@/chat/metadata/store";
import type { ConversationWorkQueue } from "./queue";
export {
  CONVERSATION_ACTIVE_INDEX_KEY,
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  CONVERSATION_WORK_CHECK_IN_INTERVAL_MS,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_STALE_ENQUEUE_MS,
  type AgentInput,
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
} from "@/chat/metadata/state-task-execution-store";
import type {
  AppendAndEnqueueInboundMessageResult,
  Conversation,
  InboundMessage,
} from "@/chat/metadata/state-task-execution-store";
import { CONVERSATION_WORK_STALE_ENQUEUE_MS } from "@/chat/metadata/state-task-execution-store";

interface MetadataStoreOptions {
  metadataStore?: ConversationMetadataStore;
  state?: StateAdapter;
}

function metadataStore(
  options: MetadataStoreOptions,
): ConversationMetadataStore {
  if (options.metadataStore) {
    return options.metadataStore;
  }
  // SQL configuration is the hard cutover for durable conversation work.
  // Injected state adapters remain the local/no-SQL backend, not a parallel
  // production path.
  if (options.state && !hasConfiguredJuniorDatabase()) {
    return createStateConversationMetadataStore(options.state);
  }
  return getConfiguredConversationMetadataStore();
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

/** Return a persisted conversation record, if one exists. */
export async function getConversation(args: {
  conversationId: string;
  metadataStore?: ConversationMetadataStore;
  state?: StateAdapter;
}) {
  return await metadataStore(args).getConversation(args);
}

/** Return a persisted conversation work record, if one exists. */
export async function getConversationWorkState(args: {
  conversationId: string;
  metadataStore?: ConversationMetadataStore;
  state?: StateAdapter;
}) {
  return await metadataStore(args).getConversationWorkState(args);
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

/** Persist one inbound message idempotently in its conversation mailbox. */
export async function appendInboundMessage(args: {
  message: InboundMessage;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).appendInboundMessage(args);
}

/** Persist inbound work and send the queue nudge that wakes a worker. */
export async function appendAndEnqueueInboundMessage(args: {
  message: InboundMessage;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<AppendAndEnqueueInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  const store = metadataStore(args);
  const appendResult = await store.appendInboundMessage({
    message: args.message,
    nowMs,
  });
  let idempotencyKey = args.message.inboundMessageId;
  if (appendResult.status === "duplicate") {
    const conversation = await store.getConversation({
      conversationId: args.message.conversationId,
    });
    if (!conversation || hasRecentEnqueueMarker(conversation, nowMs)) {
      return appendResult;
    }
    const duplicateStillPending = conversation.execution.pendingMessages.some(
      (message) => message.inboundMessageId === args.message.inboundMessageId,
    );
    if (!duplicateStillPending) {
      return appendResult;
    }
    idempotencyKey = duplicateInboundNudgeIdempotencyKey(args.message, nowMs);
  }
  const queueResult = await args.queue.send(
    {
      conversationId: args.message.conversationId,
      destination: args.message.destination,
    },
    { idempotencyKey },
  );
  await store.markConversationWorkEnqueued({
    conversationId: args.message.conversationId,
    nowMs,
  });
  return {
    ...appendResult,
    queueMessageId: queueResult?.messageId,
  };
}

/** Mark a conversation runnable when there is no new mailbox message. */
export async function requestConversationWork(args: {
  conversationId: string;
  destination: InboundMessage["destination"];
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).requestConversationWork(args);
}

/** Record visible conversation activity without making the conversation runnable. */
export async function recordConversationActivity(
  args: Parameters<
    ConversationMetadataStore["recordConversationActivity"]
  >[0] & {
    metadataStore?: ConversationMetadataStore;
    state?: StateAdapter;
  },
) {
  return await metadataStore(args).recordConversationActivity(args);
}

/** Record that a wake-up nudge was accepted for the conversation. */
export async function markConversationWorkEnqueued(args: {
  conversationId: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).markConversationWorkEnqueued(args);
}

/** Try to acquire the durable execution lease for one conversation. */
export async function startConversationWork(args: {
  conversationId: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).startConversationWork(args);
}

/** Extend the durable execution lease when the worker checks in. */
export async function checkInConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).checkInConversationWork(args);
}

/** Drain pending mailbox entries after the caller has durably injected them. */
export async function drainConversationMailbox(
  args: Parameters<ConversationMetadataStore["drainConversationMailbox"]>[0] & {
    metadataStore?: ConversationMetadataStore;
    state?: StateAdapter;
  },
) {
  return await metadataStore(args).drainConversationMailbox(args);
}

/** Mark selected leased mailbox entries after their session-log injection succeeds. */
export async function markConversationMessagesInjected(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).markConversationMessagesInjected(args);
}

/** Mark the leased conversation as needing another queue-delivered slice. */
export async function requestConversationContinuation(args: {
  conversationId: string;
  destination: InboundMessage["destination"];
  leaseToken: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).requestConversationContinuation(args);
}

/** Release the durable execution lease without changing completion state. */
export async function releaseConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).releaseConversationWork(args);
}

/** Finish a leased conversation and report whether runnable work remains. */
export async function completeConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).completeConversationWork(args);
}

/** Clear an expired durable lease so a later worker can resume safely. */
export async function clearExpiredConversationLease(args: {
  conversationId: string;
  metadataStore?: ConversationMetadataStore;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return await metadataStore(args).clearExpiredConversationLease(args);
}

/** Remove one conversation from the active index after it is missing or idle. */
export async function removeActiveConversation(args: {
  conversationId: string;
  metadataStore?: ConversationMetadataStore;
  state?: StateAdapter;
}) {
  return await metadataStore(args).removeActiveConversation(args);
}

/** List active conversation ids by oldest execution update first. */
export async function listActiveConversationIds(
  args: {
    limit?: number;
    metadataStore?: ConversationMetadataStore;
    staleBeforeMs?: number;
    state?: StateAdapter;
  } = {},
) {
  return await metadataStore(args).listActiveConversationIds(args);
}

/** List retained conversations by newest visible activity first. */
export async function listConversationsByActivity(
  args: {
    limit?: number;
    metadataStore?: ConversationMetadataStore;
    state?: StateAdapter;
  } = {},
) {
  return await metadataStore(args).listConversationsByActivity(args);
}
