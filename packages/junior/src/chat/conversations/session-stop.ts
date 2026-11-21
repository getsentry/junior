import { mapBounded } from "@/chat/fan-out";
import type { StateAdapter } from "chat";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { toStoredConversationMessage } from "@/chat/conversations/messages";
import { getConversationEventStore, getDb, getSqlExecutor } from "@/chat/db";
import { instructionForInputs } from "@/chat/agent/prompt";
import type { ConversationStore } from "@/chat/conversations/store";
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import {
  eventBatchMessageMeta,
  renderEventBatchInputs,
} from "@/chat/events/notification";
import { eventInboxItemInputs } from "@/chat/inbox-items/prompt-input";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import {
  appendAndEnqueueInboundMessage,
  stopConversationWork,
  takePendingEventMessages,
  type AppendAndEnqueueInboundMessageResult,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { StopConversationWorkResult } from "@/chat/task-execution/state";
import { cancelSignInWait } from "@/chat/task-execution/turn-cancel";
import { juniorConversations } from "@/db/schema";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";

/** Skip reason on the Message that saves input a stopped Conversation holds. */
const STOPPED_CONVERSATION_SKIP_REASON = "stopped conversation";

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
 * The hold rule: a Conversation holds automated input only while it is
 * stopped. Status and failure do not hold input.
 */
async function isHeld(conversationId: string): Promise<boolean> {
  return (await getConversationStoppedAtMs(conversationId)) !== undefined;
}

/**
 * Accept automated input, such as a Watch Event, a message from another
 * agent, or a child result. This is the only place that holds input. It
 * checks the hold under the mailbox lock, so it cannot race a stop: held
 * input is saved as a skipped Message and never reaches `pending`, and the
 * stop holds input that was appended before it.
 */
export async function enqueueAutomatedInput(
  args: Parameters<typeof appendAndEnqueueInboundMessage>[0],
): Promise<AppendAndEnqueueInboundMessageResult | { status: "held" }> {
  if (args.message.source !== "event") {
    throw new Error("Automated input must be an Event");
  }
  let held = false;
  const result = await appendAndEnqueueInboundMessage({
    ...args,
    renderText: async (inboundMessageIds, messageSenders) => {
      const text = args.renderText
        ? await args.renderText(inboundMessageIds, messageSenders)
        : args.message.input.text;
      if (text === undefined || !(await isHeld(args.message.conversationId))) {
        return text;
      }
      // Save before the mailbox records the id, so a retry after a failed
      // save holds the input again.
      await saveHeldInput(args.message.conversationId, [
        { ...args.message, input: { ...args.message.input, text } },
      ]);
      held = true;
      return undefined;
    },
  });
  return held ? { status: "held" } : result;
}

/**
 * Stop each Conversation of a tree until a person sends it input or its
 * parent gives it new work. Every stop path ends here: a person's stop,
 * `stopAgent`, and the automated-turn limit. It writes the stop in one
 * transaction with row locks, holds the automated input that already waits
 * in each mailbox, ends a Turn that waits for sign-in, and asks each running
 * Turn to stop. Each Turn it ends records one cancelled `turn_completed`.
 * Watches stay. A Conversation that already stopped later keeps that stop,
 * so a retried or cascaded stop does not move it back.
 */
export async function stopConversationTree(
  conversationIds: readonly string[],
  options: {
    conversationStore?: ConversationStore | undefined;
    /**
     * A Conversation whose Turn already finished and stops itself, as the
     * automated-turn limit does. Its run gets no stop request, so the stop
     * cannot cancel its finished Turn or the next one in the same run.
     */
    finishedRunOf?: string;
    nowMs?: number;
    /** Run once the running Turn's stop is saved. */
    onStopSaved?: () => void;
    /** Stop only person input sent at or before this time. */
    sentAtOrBeforeMs?: number;
    state?: StateAdapter | undefined;
    stoppedAtMs: number;
  },
): Promise<StopConversationWorkResult[]> {
  if (conversationIds.length === 0) {
    return [];
  }
  const stoppedAt = new Date(options.stoppedAtMs);
  await getDb().transaction(async (tx) => {
    // Lock in id order, as `resumeConversationTree` does, so a stop and a
    // resume of overlapping trees cannot deadlock.
    await tx
      .select({ conversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(inArray(juniorConversations.conversationId, [...conversationIds]))
      .orderBy(asc(juniorConversations.conversationId))
      .for("update");
    await tx
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
  });
  return await mapBounded(conversationIds, async (conversationId) => {
    const pending = await takePendingEventMessages({
      conversationId,
      conversationStore: options.conversationStore,
      nowMs: options.nowMs,
      state: options.state,
    });
    if (pending.length > 0) {
      await saveHeldInput(conversationId, pending);
    }
    await cancelSignInWait(conversationId);
    if (conversationId === options.finishedRunOf) {
      return { status: "no_work" };
    }
    return await stopConversationWork({
      conversationId,
      conversationStore: options.conversationStore,
      nowMs: options.nowMs,
      ...(options.onStopSaved ? { onStopSaved: options.onStopSaved } : {}),
      ...(options.sentAtOrBeforeMs !== undefined
        ? { sentAtOrBeforeMs: options.sentAtOrBeforeMs }
        : {}),
      state: options.state,
    });
  });
}

/**
 * End the stop of a Conversation and of the child agents below it, for new
 * work sent at `sentAtMs`: a person's input, or new work from its parent.
 * Nothing changes for work sent at or before the stop, so the input that a
 * stop drops does not undo it. Only Conversations that stopped no later than
 * this Conversation change, so a later stop of one child agent stays.
 */
export async function resumeConversationTree(
  conversationId: string,
  sentAtMs: number,
): Promise<void> {
  const subtree = sql`(select ${conversationSubtreeColumns.conversationId} from ${conversationSubtree([conversationId])})`;
  await getDb().transaction(async (tx) => {
    const rows = await tx
      .select({
        conversationId: juniorConversations.conversationId,
        stoppedAt: juniorConversations.stoppedAt,
      })
      .from(juniorConversations)
      .where(inArray(juniorConversations.conversationId, subtree))
      .orderBy(asc(juniorConversations.conversationId))
      .for("update");
    const stoppedAt = rows.find(
      (row) => row.conversationId === conversationId,
    )?.stoppedAt;
    if (!stoppedAt || sentAtMs <= stoppedAt.getTime()) {
      return;
    }
    await tx
      .update(juniorConversations)
      .set({ stoppedAt: null, detailVersion: nextDetailVersion })
      .where(
        and(
          inArray(juniorConversations.conversationId, subtree),
          lte(juniorConversations.stoppedAt, stoppedAt),
        ),
      );
  });
}

/**
 * Resume a stopped Conversation when a person sent input after the stop.
 * Known gap: input sent before the stop but received after it still runs,
 * and the Conversation stays stopped.
 */
export async function resumeForPersonInput(
  conversationId: string,
  messages: readonly InboundMessage[],
): Promise<void> {
  const personInput = messages.filter((message) =>
    isPersonInput(message.source),
  );
  if (personInput.length === 0) {
    return;
  }
  // A Slack stop takes its time from Slack, so this compares the time each
  // message was sent, not when Junior received it.
  await resumeConversationTree(
    conversationId,
    Math.max(...personInput.map((message) => message.createdAtMs)),
  );
}

/**
 * Save held input as one skipped Message, the Message that a Turn would save
 * for it, so the next Turn reads it. The append is idempotent by Message id,
 * and the Message takes the id of the first input.
 */
async function saveHeldInput(
  conversationId: string,
  messages: readonly InboundMessage[],
): Promise<void> {
  const first = messages[0]!;
  const { text } = instructionForInputs(
    renderEventBatchInputs(messages, await eventInboxItemInputs(messages)),
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
