import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { and, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { StateAdapter } from "chat";
import {
  getConversationStoppedAtMs,
  stopConversationTree,
} from "@/chat/conversations/session-stop";
import { readAgentConfig } from "@/chat/conversations/agent-config";
import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { listActiveMailboxTurns } from "@/chat/task-execution/mailbox-turn";
import { readInboundMessageSender } from "@/chat/task-execution/message-sender";
import {
  dropPendingMessages,
  getConversationWorkState,
  hasConversationStop,
} from "@/chat/task-execution/store";
import { juniorConversations } from "@/db/schema";
import { mapBounded } from "@/chat/fan-out";
import { recordChildAgentEnded } from "./markers";
import { dropWaitingParentMessages } from "./parent-message";
import { readParentMessage } from "./parent-message-input";
import { parentResultActor } from "./parent-result";
import { isStopResult } from "./child-input";
import { getChildAgentLockName } from "./ids";

/**
 * Stop one child agent of a parent Conversation and every child agent below
 * it. The parent gets no result. Each Conversation in the tree stops through
 * `stopConversationTree`, which keeps their Watches and holds their
 * automated input.
 *
 * Returns undefined when the child does not belong to the parent.
 */
export async function stopChildAgent(args: {
  childConversationId: string;
  parentConversationId: string;
  state?: StateAdapter;
}): Promise<{ stopped: boolean } | undefined> {
  // A child is stopped until new input clears its stop.
  const wasStopped =
    (await getConversationStoppedAtMs(args.childConversationId)) !== undefined;
  const conversationIds = await lockOwnedChildAgentTree(args);
  if (!conversationIds) {
    return undefined;
  }
  await finishStoppedTree(conversationIds, {
    stoppedAtMs: Date.now(),
    state: args.state,
  });
  await dropUnreadLoopReplies(
    [args.parentConversationId, ...conversationIds],
    conversationIds,
    args.state,
  );
  return { stopped: !wasStopped };
}

/**
 * Stop the child agents of a Conversation whose run saw its stop. The work
 * path in `app/conversation-work.ts` calls it after the run, for a root or a
 * child agent. So this sends no stop request to that Conversation.
 *
 * The run can see its stop late. The stop already reached every child agent
 * that existed then, so this stops only child agents that this Conversation
 * spawned after its stop, even when they already finished, and everything
 * below them. A child that a person resumed after the stop keeps running.
 * When the stop already ended, because a person or the parent gave the
 * Conversation new input, this does nothing.
 *
 * Only a person's stop of this Conversation itself leaves child agents to
 * stop here: an agent stop, or a stop of a Conversation above it, stops this
 * Conversation first under its lock, so it cannot spawn more.
 */
export async function stopChildAgentsOf(
  conversationId: string,
  state?: StateAdapter,
): Promise<void> {
  const stoppedAtMs = await getConversationStoppedAtMs(conversationId);
  if (stoppedAtMs === undefined) {
    return;
  }
  const nowMs = Date.now();
  const conversationIds = await lockChildAgentTree(conversationId, {
    createdAfterMs: stoppedAtMs,
  });
  // They take the stop of this Conversation, so input that ends it ends
  // theirs too.
  const stoppedIds = conversationIds.filter((id) => id !== conversationId);
  await finishStoppedTree(stoppedIds, {
    nowMs,
    stoppedAtMs,
    state,
  });
  await dropUnreadLoopReplies(conversationIds, stoppedIds, state);
  await dropOwnUnreadLoopReplies(conversationId, state);
}

/**
 * Stop every child agent below a Conversation that a person stops. Call it
 * through `stopConversation`, which cancels the Conversation's own waiting
 * parent messages and stops its Turn next.
 *
 * The Conversation's run sees its stop only at its next stop signal check.
 * When it does, `stopChildAgentsOf` stops the child agents that it spawned
 * after this stop, at the time of this stop. So
 * input that ends this stop ends theirs too.
 */
export async function stopChildAgentsBelow(
  conversationId: string,
  options: {
    nowMs: number;
    /** Delivers each child agent's stop to its Watches. */
    queue?: ConversationWorkQueue | undefined;
    stoppedAtMs: number;
    state?: StateAdapter | undefined;
  },
): Promise<void> {
  const { nowMs, queue, stoppedAtMs, state } = options;
  const conversationIds = await lockChildAgentTree(conversationId);
  const stoppedIds = conversationIds.filter((id) => id !== conversationId);
  await finishStoppedTree(stoppedIds, {
    nowMs,
    queue,
    stoppedAtMs,
    state,
  });
  await dropUnreadLoopReplies(conversationIds, stoppedIds, state);
}

/**
 * Drop the unread replies that the stopped Conversations left in each
 * mailbox of `mailboxIds`, by their sender fields.
 * A reply sent after the stop is dropped when it is read, while the sender
 * is stopped. Call this after the stop is stored.
 *
 * A reply that a running Turn already took leaves the mailbox like one that
 * it read: the Turn's own ack removes nothing more.
 */
async function dropUnreadLoopReplies(
  mailboxIds: readonly string[],
  stoppedIds: readonly string[],
  state: StateAdapter | undefined,
): Promise<void> {
  const stopped = new Set(stoppedIds);
  await mapBounded(mailboxIds, async (conversationId) => {
    const messages =
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    const inboundMessageIds = messages.flatMap((message) => {
      const sender = readInboundMessageSender(message);
      // The `stopped` result of the stop itself stays: it reports the stop.
      return sender &&
        !isStopResult(message) &&
        stopped.has(sender.conversationId)
        ? [message.inboundMessageId]
        : [];
    });
    if (inboundMessageIds.length > 0) {
      await dropPendingMessages({
        conversationId,
        inboundMessageIds,
        state,
      });
    }
  });
}

/**
 * Drop the unread loop replies that a Conversation that a person stopped
 * left in its parent's mailbox, outside its tree. Call this after its stop
 * is stored: the parent mailbox lock then drops a later reply.
 */
export async function dropOwnUnreadLoopReplies(
  conversationId: string,
  state?: StateAdapter,
): Promise<void> {
  // A child agent has one parent, so this finds at most one mailbox.
  const parents = await getSqlExecutor()
    .db()
    .select({ id: juniorConversations.parentConversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  await dropUnreadLoopReplies(
    parents.flatMap((parent) => (parent.id ? [parent.id] : [])),
    [conversationId],
    state,
  );
}

/**
 * Finish the stop of each Conversation in a stopped tree: cancel its waiting
 * parent messages, then stop it through `stopConversationTree`.
 */
async function finishStoppedTree(
  conversationIdsToStop: string[],
  options: Omit<Parameters<typeof stopConversationTree>[1], "onStopSaved">,
): Promise<void> {
  await mapBounded(conversationIdsToStop, (conversationId) =>
    cancelWaitingParentMessages(conversationId, {
      nowMs: options.stoppedAtMs,
      state: options.state,
    }),
  );
  await stopConversationTree(conversationIdsToStop, options);
}

/**
 * Cancel the parent messages that wait for a Conversation that stops: end
 * their markers and drop them. Call it before the stop request is saved, so
 * none of them runs after the stop and no stop request outlives the stop.
 */
export async function cancelWaitingParentMessages(
  conversationId: string,
  options: { nowMs?: number | undefined; state?: StateAdapter | undefined },
): Promise<void> {
  await recordChildAgentEnded(conversationId, "aborted", {
    includeWaiting: true,
    nowMs: options.nowMs,
    state: options.state,
  });
  await dropWaitingParentMessages(conversationId, options.state);
}

/**
 * Tell the parent of a child agent that a person stops it, when the stop
 * cuts work: waiting input or a running Turn, whoever started it. Call it
 * before the stop request is saved, so a failure leaves the stop to be
 * retried. An idle child already sent its result, so it stays quiet, and so
 * does a run that an earlier stop already cut. The result is keyed by the
 * stop time, which a redelivery of the same stop keeps, so a retry adds
 * nothing even when a worker took the waiting work in between.
 */
export async function reportPersonStopToParent(
  conversationId: string,
  options: {
    queue: ConversationWorkQueue;
    state?: StateAdapter | undefined;
    stoppedAtMs: number;
  },
): Promise<void> {
  // Only a child agent stores an agent config. Advisor histories from before
  // child agents also have a parent edge, but they are not child agents.
  if (!(await readAgentConfig(conversationId))) {
    return;
  }
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) {
    return;
  }
  const work = await getConversationWorkState({
    conversationId,
    state: options.state,
  });
  const runId = work?.execution.runId;
  if (
    runId &&
    (await hasConversationStop({ conversationId, runId, state: options.state }))
  ) {
    return;
  }
  const [firstWaiting] = (work?.messages ?? []).flatMap((message) => {
    const parentMessage = readParentMessage(message);
    return parentMessage ? [parentMessage] : [];
  });
  const [turn] = runId ? await listActiveMailboxTurns(conversationId) : [];
  if (!runId && !work?.messages.length) {
    return;
  }
  await publishAgentUpdate(
    conversationId,
    { type: "stopped", stoppedAtMs: options.stoppedAtMs },
    {
      queue: options.queue,
      // A waiting parent message keeps the Actor of the agent that sent it.
      starter: turn?.actor
        ? parentResultActor(turn.actor, turn.source?.kind)
        : (firstWaiting?.actor ?? EVENT_SYSTEM_ACTOR),
      state: options.state,
      update: async () => ({
        status: "stopped",
        text: `A person stopped this ${conversation.kind}.`,
      }),
    },
  );
}

/**
 * List one Conversation and every child agent below it, the Conversation
 * first. It takes the create lock of each Conversation before it reads that
 * Conversation's children, so no child agent can start in the tree until the
 * caller's transaction ends. Each child agent stores its agent config.
 */
async function lockAgentConversationTree(
  conversationId: string,
): Promise<string[]> {
  const executor = getSqlExecutor();
  const conversationIds = [conversationId];
  let parents = conversationIds;
  /* oxlint-disable no-await-in-loop -- Each level reads the children of the level before, after it holds their parents' locks. */
  while (parents.length > 0) {
    for (const parent of parents) {
      await executor.withLock(
        getChildAgentLockName(parent),
        async () => undefined,
      );
    }
    const rows = await executor
      .db()
      .select({ childConversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(
        and(
          inArray(juniorConversations.parentConversationId, parents),
          isNotNull(juniorConversations.agentConfig),
        ),
      );
    parents = rows
      .map((row) => row.childConversationId)
      .filter((id) => !conversationIds.includes(id));
    conversationIds.push(...parents);
  }
  /* oxlint-enable no-await-in-loop */
  return conversationIds;
}

/**
 * Keep a Conversation, its child agents created after `createdAfterMs`, and
 * every Conversation below those child agents. A stopped parent gives a
 * child agent no work, so only a spawn that raced the stop created one after
 * it.
 */
async function withChildAgentsCreatedAfter(
  conversationId: string,
  conversationIds: readonly string[],
  createdAfterMs: number,
): Promise<string[]> {
  const links = await getSqlExecutor()
    .db()
    .select({
      childConversationId: juniorConversations.conversationId,
      parentConversationId: juniorConversations.parentConversationId,
    })
    .from(juniorConversations)
    .where(
      and(
        inArray(juniorConversations.parentConversationId, [...conversationIds]),
        isNotNull(juniorConversations.agentConfig),
        or(
          ne(juniorConversations.parentConversationId, conversationId),
          gt(juniorConversations.createdAt, new Date(createdAfterMs)),
        ),
      ),
    );
  const kept = [conversationId];
  for (let index = 0; index < kept.length; index += 1) {
    for (const link of links) {
      if (
        link.parentConversationId === kept[index] &&
        !kept.includes(link.childConversationId)
      ) {
        kept.push(link.childConversationId);
      }
    }
  }
  return kept;
}

/**
 * Lock the tree of one direct child agent of a parent. Returns undefined
 * when the child does not belong to the parent.
 */
async function lockOwnedChildAgentTree(args: {
  childConversationId: string;
  parentConversationId: string;
}): Promise<string[] | undefined> {
  const [child] = await getSqlExecutor()
    .db()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.conversationId, args.childConversationId),
        eq(juniorConversations.parentConversationId, args.parentConversationId),
        isNotNull(juniorConversations.agentConfig),
      ),
    );
  return child ? await lockChildAgentTree(args.childConversationId) : undefined;
}

/**
 * List one agent Conversation and every child agent below it, under the
 * create locks of the tree, so the read sees every spawn that committed
 * before it. With
 * `createdAfterMs`, only the direct child agents created after that time,
 * and the Conversations below them, are listed.
 */
async function lockChildAgentTree(
  conversationId: string,
  options: { createdAfterMs?: number } = {},
): Promise<string[]> {
  return await getSqlExecutor().withLock(
    getChildAgentLockName(conversationId),
    async () => {
      const lockedIds = await lockAgentConversationTree(conversationId);
      return options.createdAfterMs === undefined
        ? lockedIds
        : await withChildAgentsCreatedAfter(
            conversationId,
            lockedIds,
            options.createdAfterMs,
          );
    },
  );
}
