import { mapBounded } from "@/chat/fan-out";
import type { StateAdapter } from "chat";
import { and, asc, inArray, isNull, lt, or } from "drizzle-orm";
import { STOPPED_CONVERSATION_SKIP_REASON } from "@/chat/conversations/held-input";
import { getChatConfig } from "@/chat/config";
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
import { stopTurns } from "@/core/turn/schedule";
import { juniorConversations } from "@/db/schema";
import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import {
  getConversationStoppedAtMs,
  resumeConversationTree,
} from "@/chat/conversations/stop-state";
import { compat__stoppedMessages } from "@/turn-steps/compat__stopped-input";
import { createEngineContext } from "@/turn-steps/engine-context";

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
 * Watches stay, and each Conversation that this stop starts reports
 * a `stopped` agent update to them. A Conversation that already stopped later
 * keeps that stop, so a retried or cascaded stop does not move it back.
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
    /** Delivers each new stop to the Watches on its Conversation. */
    queue?: ConversationWorkQueue | undefined;
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
  const reported = await getSqlExecutor().transaction(async () => {
    // The executor's transaction nests as a savepoint inside a caller's
    // lock. A Drizzle transaction would commit the caller's.
    const tx = getDb();
    // Lock in id order, as `resumeConversationTree` does, so a stop and a
    // resume of overlapping trees cannot deadlock.
    const locked = await tx
      .select({
        conversationId: juniorConversations.conversationId,
        stoppedAt: juniorConversations.stoppedAt,
      })
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
    // A Conversation that was running reports this stop. A retry of a stop
    // that failed before its report finds its own stop time and reports it
    // again; the Event key holds the stop time, so it delivers once. A later
    // stop of a stopped Conversation reports nothing.
    return locked.flatMap((row) =>
      !row.stoppedAt || row.stoppedAt.getTime() === stoppedAt.getTime()
        ? [row.conversationId]
        : [],
    );
  });
  const queue = options.queue ?? getVercelConversationWorkQueue();
  await mapBounded(reported, (conversationId) =>
    publishAgentUpdate(
      conversationId,
      { type: "stopped", stoppedAtMs: stoppedAt.getTime() },
      {
        nowMs: stoppedAt.getTime(),
        queue,
        // Whoever stopped the tree knows. A person's stop of a child agent
        // tells its starter in `reportPersonStopToParent`.
        starter: false,
        state: options.state,
        update: async () => ({
          status: "stopped",
          text: "This conversation was stopped.",
        }),
      },
    ),
  );
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
    if (getChatConfig().turnEngine === "core") {
      return await stopCoreTurns(conversationId, options);
    }
    return await stopConversationWork({
      conversationId,
      conversationStore: options.conversationStore,
      nowMs: options.nowMs,
      onStopSaved: options.onStopSaved,
      sentAtOrBeforeMs: options.sentAtOrBeforeMs,
      state: options.state,
    });
  });
}

/**
 * Cancel the queued and running core Turns of a Conversation by sent time.
 * The person input that the stop drops, and no attempt claimed, comes back
 * as main's pending messages. Person input sent after the stop moved to a
 * new Turn, so it ends the stop, as it does when it arrives later. The first
 * stopped Turn stands in for main's run.
 */
async function stopCoreTurns(
  conversationId: string,
  options: {
    onStopSaved?: (() => void) | undefined;
    sentAtOrBeforeMs?: number | undefined;
  },
): Promise<StopConversationWorkResult> {
  const { turnIds, dropped, moved } = await stopTurns(
    createEngineContext(getChatConfig()),
    conversationId,
    { sentAtOrBeforeMs: options.sentAtOrBeforeMs },
  );
  const [turnId] = turnIds;
  if (!turnId) {
    return { status: "no_work" };
  }
  options.onStopSaved?.();
  const movedPersonInput = moved.filter((input) =>
    isPersonInput(input.source.kind),
  );
  if (movedPersonInput.length > 0) {
    await resumeConversationTree(
      conversationId,
      Math.max(...movedPersonInput.map((input) => input.sentAt.getTime())),
    );
  }
  return {
    status: "requested",
    runId: turnId,
    // A claimed input is in the transcript already, as main's drained one is.
    pendingMessages: compat__stoppedMessages(
      conversationId,
      dropped.filter((input) => input.attemptedAt === null),
    ),
  };
}

/**
 * Resume a stopped Conversation when a person sent input after the stop.
 * Known gap on main's Turn engine: input sent before the stop but received
 * after it still runs, and the Conversation stays stopped. The core Turn
 * engine drops that input at intake (`scheduleInboundMessage`).
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
 * for it. The next Turn gets it as Turn input (`withHeldInput`). The append
 * is idempotent by Message id, and the Message takes the id of the first
 * input.
 */
export async function saveHeldInput(
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
