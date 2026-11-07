import type { StateAdapter } from "chat";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { toStoredConversationMessage } from "@/chat/conversations/messages";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import { instructionForInputs } from "@/chat/agent/prompt";
import {
  eventBatchMessageMeta,
  isEventMailboxMetadata,
  renderEventBatchInputs,
} from "@/chat/events/notification";
import { cancelSubscriptions } from "@/chat/events/store";
import { getEventBatchDelayMs } from "@/chat/task-execution/mailbox-turn";
import { eventReviewItemInputs } from "@/chat/review-items/prompt-input";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import type { InboundMessage } from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { juniorConversations } from "@/db/schema";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";

/** Skip reason on the Message that saves Events for a stopped Conversation. */
const STOPPED_CONVERSATION_SKIP_REASON = "stopped conversation";

/**
 * Stop each Conversation until a person sends it input or its parent gives
 * it new work. With `cancelWatches`, an agent stopped them, so their Watches
 * end first: a Watch delivers under its lock, so every Event of a cancelled
 * Watch was received before the stop. A Conversation that already stopped
 * later keeps that stop, so a retried or cascaded stop does not move it back.
 */
export async function markConversationsStopped(
  conversationIds: readonly string[],
  options: { cancelWatches: boolean; nowMs?: number; state?: StateAdapter },
): Promise<void> {
  if (conversationIds.length === 0) {
    return;
  }
  if (options.cancelWatches) {
    for (const conversationId of conversationIds) {
      await cancelSubscriptions({ conversationId, state: options.state });
    }
  }
  const stoppedAt = new Date(options.nowMs ?? Date.now());
  await getSqlExecutor()
    .db()
    .update(juniorConversations)
    .set({ stoppedAt, detailVersion: nextDetailVersion })
    .where(
      and(
        inArray(juniorConversations.conversationId, [...conversationIds]),
        or(
          isNull(juniorConversations.stoppedAt),
          lt(juniorConversations.stoppedAt, stoppedAt),
        ),
      ),
    );
}

/** Return when a Conversation stopped, or undefined when it is not stopped. */
export async function getConversationStoppedAtMs(
  conversationId: string,
): Promise<number | undefined> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ stoppedAt: juniorConversations.stoppedAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row?.stoppedAt?.getTime();
}

/**
 * End the stop of a Conversation and of the child agents below it, for new
 * work sent at `sentAtMs`. Nothing changes for work sent at or before the
 * stop, so the input that a stop drops does not undo it.
 * Only Conversations that stopped no later than this Conversation change, so
 * a later stop of one child agent stays in effect.
 */
export async function resumeStoppedConversationTree(
  conversationId: string,
  sentAtMs: number,
): Promise<void> {
  const stoppedAtMs = await getConversationStoppedAtMs(conversationId);
  if (stoppedAtMs === undefined || sentAtMs <= stoppedAtMs) {
    return;
  }
  await getSqlExecutor()
    .db()
    .update(juniorConversations)
    .set({ stoppedAt: null, detailVersion: nextDetailVersion })
    .where(
      and(
        inArray(
          juniorConversations.conversationId,
          sql`(select ${conversationSubtreeColumns.conversationId} from ${conversationSubtree([conversationId])})`,
        ),
        lte(juniorConversations.stoppedAt, new Date(stoppedAtMs)),
      ),
    );
}

/**
 * Apply a session stop to automated input. Input from a person always runs.
 * When a person sent it after the stop, the Conversation and its child agents
 * stop no more. Input from a parent tool call also runs. While the
 * Conversation is stopped, its Watch Events are saved as one Message and
 * start no Turn, and other Events received at or before the stop are
 * dropped. Returns the work to run, with only the Events that are left, or
 * the finished result when nothing is left.
 */
export async function skipInputAfterConversationStop(
  context: ConversationWorkerContext,
): Promise<
  { context: ConversationWorkerContext } | { skipped: ConversationWorkerResult }
> {
  const messages = context.attempt.messages;
  const personInput = messages.filter(isPersonInput);
  if (personInput.length > 0) {
    // The batch can still hold input that the stop cancels. Only input sent
    // after the stop ends it. A Slack stop takes its time from Slack, so this
    // compares the time each message was sent, not when Junior received it.
    await resumeStoppedConversationTree(
      context.conversationId,
      Math.max(...personInput.map((message) => message.createdAtMs)),
    );
    return { context };
  }
  if (messages.length === 0 || !messages.every(isEventInput)) {
    return { context };
  }
  const stoppedAtMs = await getConversationStoppedAtMs(context.conversationId);
  if (stoppedAtMs === undefined) {
    return { context };
  }
  const saved = messages.filter(isWatchEvent);
  const live = messages.filter(
    (message) => !isWatchEvent(message) && message.receivedAtMs > stoppedAtMs,
  );
  if (live.length > 0 && saved.length > 0) {
    // Events of all Watches debounce in one batch. Wait out the window of the
    // whole batch and of the Events that run before any Event is saved, so a
    // later attempt does not save the Events again.
    const delayMs = Math.max(
      getEventBatchDelayMs(messages),
      getEventBatchDelayMs(live),
    );
    if (delayMs > 0) {
      return { skipped: { status: "deferred", delayMs } };
    }
  }
  if (saved.length > 0) {
    await saveStoppedConversationEvents(context.conversationId, saved);
  }
  if (live.length === messages.length) {
    return { context };
  }
  if (live.length > 0) {
    // The ack of the attempt still covers the saved and dropped Events.
    return {
      context: { ...context, attempt: { ...context.attempt, messages: live } },
    };
  }
  await context.attempt.ack();
  return { skipped: { status: "completed" } };
}

function isPersonInput(message: InboundMessage): boolean {
  return message.source === "web" || message.source === "slack";
}

function isEventInput(message: InboundMessage): boolean {
  return (
    message.source === "event" && isEventMailboxMetadata(message.input.metadata)
  );
}

/** Return whether a Watch delivered this input. Agent input has none. */
export function isWatchEvent(message: InboundMessage): boolean {
  const metadata = message.input.metadata;
  return (
    isEventMailboxMetadata(metadata) &&
    metadata.event.subscriptionId !== undefined
  );
}

/**
 * Save Events as the one Message that a Turn would save for them. The append
 * is idempotent by Message id, so a retried batch saves nothing new. The
 * Message takes the id of the first saved Event, so when an ack is lost and
 * the retry carries more Events to save, the extra Events are deduplicated
 * away.
 */
async function saveStoppedConversationEvents(
  conversationId: string,
  messages: readonly InboundMessage[],
): Promise<void> {
  const first = messages[0]!;
  const { text } = instructionForInputs(
    renderEventBatchInputs(messages, await eventReviewItemInputs(messages)).map(
      (input) => ({ kind: "runtime" as const, text: input }),
    ),
  );
  const stored = toStoredConversationMessage({
    id: first.inboundMessageId,
    role: "user",
    text: normalizeConversationText(text),
    createdAtMs: first.createdAtMs,
    ...(first.input.authorIdentityId
      ? { authorIdentityId: first.input.authorIdentityId }
      : undefined),
    meta: {
      replied: false,
      skippedReason: STOPPED_CONVERSATION_SKIP_REASON,
      ...eventBatchMessageMeta(messages),
    },
  });
  const { createdAtMs, ...data } = stored;
  await getConversationEventStore().append(conversationId, [
    {
      idempotencyKey: `message:${stored.messageId}`,
      createdAtMs,
      data: { type: "message", ...data },
    },
  ]);
}
