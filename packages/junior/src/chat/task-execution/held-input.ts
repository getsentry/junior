/**
 * The mailbox hold of a stopped Conversation. Held input keeps its original
 * inbound messages, with their Event metadata, in a list next to the mailbox
 * record. A resume puts them back into pending input, so the normal mailbox
 * batch delivers them.
 */
import type { StateAdapter } from "chat";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { isAttemptInterrupt } from "./attempt-selection";
import {
  compareMessages,
  CONVERSATION_PREFIX,
  getConnectedState,
  inboundMessageSchema,
  isLeaseActive,
  readConversation,
  uniqueStrings,
  withConversationMutation,
  withExecutionUpdate,
  writeConversation,
  type ExecutionStatus,
  type InboundMessage,
} from "./state";

function heldInputKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:held:${conversationId}`;
}

/**
 * Keep held inbound messages until the Conversation resumes. Call it under
 * the mailbox lock, so it cannot land between the read and the delete of a
 * release.
 */
export async function holdInboundMessages(
  conversationId: string,
  messages: readonly InboundMessage[],
  stateAdapter?: StateAdapter,
): Promise<void> {
  const state = await getConnectedState(stateAdapter);
  await appendHeld(state, conversationId, messages);
}

async function appendHeld(
  state: StateAdapter,
  conversationId: string,
  messages: readonly InboundMessage[],
): Promise<void> {
  for (const message of messages) {
    // oxlint-disable-next-line no-await-in-loop -- Keep the held order.
    await state.appendToList(heldInputKey(conversationId), message, {
      ttlMs: JUNIOR_THREAD_STATE_TTL_MS,
    });
  }
}

/**
 * Put the held input of a resumed Conversation back into pending input, and
 * return how many messages it added. Input that is already pending is not
 * added again. The status follows the rules of a new append.
 */
export async function releaseHeldInput(args: {
  conversationId: string;
  isStopped: () => Promise<boolean>;
  nowMs?: number;
  state?: StateAdapter | undefined;
}): Promise<number> {
  const nowMs = args.nowMs ?? Date.now();
  const key = heldInputKey(args.conversationId);
  return await withConversationMutation(args, async (state, lock) => {
    // A stop takes pending input under this lock. So a stop that lands after
    // this check takes the released input back and holds it again.
    if (await args.isStopped()) {
      return 0;
    }
    const held = (await state.getList(key)).flatMap((value) => {
      const parsed = inboundMessageSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    if (held.length === 0) {
      return 0;
    }
    const current = await readConversation(state, args.conversationId);
    if (!current) {
      await state.delete(key);
      return 0;
    }
    const pendingIds = new Set(
      current.execution.pendingMessages.map(
        (message) => message.inboundMessageId,
      ),
    );
    const released = held.filter((message) => {
      if (pendingIds.has(message.inboundMessageId)) return false;
      pendingIds.add(message.inboundMessageId);
      return true;
    });
    if (released.length > 0) {
      let status: ExecutionStatus;
      if (current.execution.lease) {
        status = current.execution.status === "running" ? "running" : "paused";
      } else if (
        current.execution.status === "paused" &&
        !released.some((message) => isAttemptInterrupt(message, current))
      ) {
        status = "paused";
      } else {
        status = "pending";
      }
      await writeConversation(
        state,
        lock,
        withExecutionUpdate(
          { ...current, lastActivityAtMs: nowMs },
          {
            ...current.execution,
            status,
            pendingMessages: [
              ...current.execution.pendingMessages,
              ...released,
            ].sort(compareMessages),
          },
          nowMs,
        ),
      );
    }
    await state.delete(key);
    return released.length;
  });
}

/**
 * Remove the pending Event input of a Conversation, hold it, and return it,
 * so a stop holds input that reached the mailbox before it. The input of a
 * running attempt stays and is marked held: that Turn saves it, or the next
 * claim holds it.
 */
export async function takePendingEventMessages(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter | undefined;
}): Promise<InboundMessage[]> {
  const nowMs = args.nowMs ?? Date.now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current) {
      return [];
    }
    const lease = current.execution.lease;
    const runningIds = new Set(
      isLeaseActive(lease, nowMs) ? lease?.attemptInboundMessageIds : [],
    );
    const events = current.execution.pendingMessages.filter(
      (message) => message.source === "event",
    );
    const removed = events.filter(
      (message) => !runningIds.has(message.inboundMessageId),
    );
    const held = events
      .filter((message) => runningIds.has(message.inboundMessageId))
      .map((message) => message.inboundMessageId);
    if (removed.length === 0 && held.length === 0) {
      return [];
    }
    const pendingMessages = current.execution.pendingMessages.filter(
      (message) => !removed.includes(message),
    );
    const becomesIdle =
      current.execution.status === "pending" && pendingMessages.length === 0;
    await appendHeld(state, args.conversationId, removed);
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          heldInboundMessageIds: uniqueStrings([
            ...(current.execution.heldInboundMessageIds ?? []),
            ...held,
          ]),
          lastEnqueuedAtMs:
            pendingMessages.length === 0
              ? undefined
              : current.execution.lastEnqueuedAtMs,
          pendingMessages,
          retryCount: becomesIdle ? 0 : current.execution.retryCount,
          runId: becomesIdle ? undefined : current.execution.runId,
          status: becomesIdle ? "idle" : current.execution.status,
        },
        nowMs,
      ),
    );
    return removed;
  });
}
