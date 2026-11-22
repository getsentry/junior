import { and, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { StateAdapter } from "chat";
import {
  getConversationStoppedAtMs,
  markConversationsStopped,
} from "@/chat/conversations/session-stop";
import { readAgentConfig } from "@/chat/conversations/agent-config";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { listActiveMailboxTurns } from "@/chat/task-execution/mailbox-turn";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { cancelSignInWait } from "@/chat/task-execution/turn-cancel";
import {
  dropPendingMessages,
  getConversationWorkState,
  stopConversationWork,
} from "@/chat/task-execution/store";
import { juniorAgentInvocations, juniorConversations } from "@/db/schema";
import { mapBounded } from "@/chat/fan-out";
import { recordChildAgentEnded, recordSubagentEnded } from "./markers";
import { dropWaitingParentMessages } from "./parent-message";
import type { ParentMessage } from "./parent-message-input";
import { createDeliverToParent } from "./result";
import { isChildAgentSessionStopped } from "./list";
import { getChildAgentLockName } from "./ids";
import { ownAgentInvocation, readChildMessageSenders } from "./child-message";
import {
  getLatestAgentInvocationForConversation,
  invocationFromRow,
  isTerminalAgentInvocation,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
} from "./store";
import type { TerminalAgentInvocation } from "./types";

/**
 * Stop one child agent of a parent Conversation and every child agent below
 * it. The parent gets no result. SQL stops the work first. Then each
 * Conversation in the tree ends its session. An agent stop is not a person
 * stop, so their Watches end. A Conversation stop request aborts each run
 * that is still working.
 *
 * Returns undefined when the child does not belong to the parent.
 */
export async function stopChildAgent(args: {
  childConversationId: string;
  parentConversationId: string;
  state?: StateAdapter;
}): Promise<{ stopped: boolean } | undefined> {
  const [latest, stoppedAtMs] = await Promise.all([
    getLatestAgentInvocationForConversation(args.childConversationId),
    getConversationStoppedAtMs(args.childConversationId),
  ]);
  // A child that no Agent invocation names is stopped until new input clears
  // its stop.
  const wasStopped = latest
    ? latest.status === "stopped" ||
      isChildAgentSessionStopped(latest, stoppedAtMs)
    : stoppedAtMs !== undefined;
  const tree = await stopChildAgentInvocations(args);
  if (!tree) {
    return undefined;
  }
  await finishStoppedTree(tree, tree.conversationIds, {
    cancelWatches: true,
    state: args.state,
  });
  await dropUnreadLoopReplies(
    [args.parentConversationId, ...tree.conversationIds],
    tree.conversationIds,
    args.state,
  );
  return { stopped: tree.stopped.length > 0 || !wasStopped };
}

/**
 * Stop the child agents of a Conversation whose run saw its stop. A child
 * agent's worker calls this after it records its own stop, and the root work
 * path in `app/conversation-work.ts` calls it for a root. So this sends no
 * stop request to that Conversation.
 *
 * The worker can see its stop late. The stop already reached every child
 * agent that existed then, so this stops only child agents that this
 * Conversation spawned or gave an Agent invocation to after its stop, even
 * when they already finished, and everything below them. A child that a
 * person resumed after the stop keeps running. When the stop already ended,
 * because a person or the parent gave the Conversation new input, this does
 * nothing.
 *
 * Only a person's stop of this Conversation itself leaves child agents to
 * stop here: an agent stop, or a stop of a Conversation above it, stops this
 * Conversation's own Agent invocations first, so it cannot spawn more. So
 * this keeps their Watches, as a person's stop does.
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
  // The Conversation's own work already ended. Leave its read results as they
  // are, so `listChildAgents` still shows them.
  const tree = await stopAgentInvocationTree(conversationId, nowMs, {
    createdAfterMs: stoppedAtMs,
    includeRoot: false,
  });
  await skipUnreadResults(conversationId, nowMs, state);
  // They take the stop of this Conversation, so input that ends it ends
  // theirs too.
  const stoppedIds = tree.conversationIds.filter((id) => id !== conversationId);
  await finishStoppedTree(tree, stoppedIds, {
    cancelWatches: false,
    nowMs: stoppedAtMs,
    state,
  });
  await dropUnreadLoopReplies(tree.conversationIds, stoppedIds, state);
  await dropOwnUnreadLoopReplies(conversationId, state);
}

/**
 * Stop every child agent below a Conversation that a person stops. The
 * Conversation's own Agent invocations stay as they are: when it is a child
 * agent, its worker records the stop and reports it to its parent. Call it
 * through `stopConversation`, which cancels the Conversation's own waiting
 * parent messages and stops its Turn next.
 *
 * The Conversation's run sees its stop only at its next stop signal check.
 * When it does, `stopChildAgentsOf` stops the child agents that it spawned or
 * gave an Agent invocation to after this stop, at the time of this stop. So
 * input that ends this stop ends theirs too.
 */
export async function stopChildAgentsBelow(
  conversationId: string,
  options: {
    nowMs: number;
    stoppedAtMs: number;
    state?: StateAdapter | undefined;
  },
): Promise<void> {
  const { nowMs, stoppedAtMs, state } = options;
  const tree = await stopAgentInvocationTree(conversationId, nowMs, {
    includeRoot: false,
  });
  await skipUnreadResults(conversationId, nowMs, state);
  const stoppedIds = tree.conversationIds.filter((id) => id !== conversationId);
  await finishStoppedTree(tree, stoppedIds, {
    cancelWatches: false,
    nowMs: stoppedAtMs,
    state,
  });
  await dropUnreadLoopReplies(tree.conversationIds, stoppedIds, state);
}

/**
 * Skip the `appended` results and replies that still wait in a Conversation's
 * mailbox, so they start no Turn. A result that the Conversation already read keeps its
 * status. Call this after the tree stop: it skipped each `pending` result and
 * stopped each child agent, so no result becomes `appended` after this read.
 *
 * The mailbox read is not atomic with the parent worker. A worker that takes
 * a result before this update holds the work lease, so the stop request of
 * the Conversation stops its Turn. A result that such a Turn took but did not
 * ack yet is marked `skipped`.
 */
async function skipUnreadResults(
  conversationId: string,
  nowMs: number,
  state: StateAdapter | undefined,
): Promise<void> {
  const messages =
    (await getConversationWorkState({ conversationId, state }))?.messages ?? [];
  // A child's `reply` is its result, so a stop skips it too. A reply from a
  // Turn on the Conversation loop names no work of its own:
  // `dropUnreadLoopReplies` drops it instead.
  const invocationIds = (await readChildMessageSenders(messages)).flatMap(
    (sender) => {
      const invocation = sender && ownAgentInvocation(sender);
      return invocation ? [invocation] : [];
    },
  );
  if (invocationIds.length === 0) {
    return;
  }
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ parentMailboxStatus: "skipped", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.parentConversationId, conversationId),
        inArray(juniorAgentInvocations.invocationId, invocationIds),
        eq(juniorAgentInvocations.parentMailboxStatus, "appended"),
      ),
    );
}

/**
 * Drop the unread replies that Turns on the Conversation loop of the stopped
 * Conversations left in each mailbox of `mailboxIds`. Such a reply names
 * no work that the stop skips, so the stop drops it by its sender fields.
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
    const senders = await readChildMessageSenders(messages);
    const inboundMessageIds = messages.flatMap((message, index) => {
      const sender = senders[index];
      return sender &&
        !ownAgentInvocation(sender) &&
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
 * Finish the stop of each Conversation in a stopped tree: end the markers of
 * its stopped Agent invocations, cancel its waiting parent messages, mark it
 * stopped, and save its stop request.
 *
 * A Thread can hold a person's Turn that waits for sign-in. The stop ends
 * that Turn here, because no worker holds it. Then a later sign-in callback
 * cannot resume a stopped Thread.
 */
async function finishStoppedTree(
  tree: StoppedAgentTree,
  conversationIdsToStop: string[],
  options: Parameters<typeof markConversationsStopped>[1],
): Promise<void> {
  for (const invocation of tree.stopped) {
    // oxlint-disable-next-line no-await-in-loop -- Append the end markers in stop order.
    await recordSubagentEnded(invocation);
  }
  await mapBounded(conversationIdsToStop, (conversationId) =>
    cancelWaitingParentMessages(conversationId, options),
  );
  await markConversationsStopped(conversationIdsToStop, options);
  await mapBounded(conversationIdsToStop, async (conversationId) => {
    await cancelSignInWait(conversationId);
    await stopConversationWork({ conversationId, state: options.state });
  });
}

/**
 * Cancel the parent messages that wait for a Conversation that stops: end
 * their markers and drop them. Call it before the stop request is saved, so
 * none of them runs after the stop and no stop request outlives the stop.
 * Returns the parent messages it dropped.
 */
export async function cancelWaitingParentMessages(
  conversationId: string,
  options: { nowMs?: number | undefined; state?: StateAdapter | undefined },
): Promise<ParentMessage[]> {
  await recordChildAgentEnded(conversationId, "aborted", {
    includeWaiting: true,
    nowMs: options.nowMs,
    state: options.state,
  });
  return await dropWaitingParentMessages(conversationId, options.state);
}

/**
 * Tell the parent of a Task that no Agent invocation names that a person
 * stopped it, when the stop cut its work: it dropped waiting parent messages
 * or asked a running Turn to stop. The Agent invocation worker reports the
 * stop of a child that has one. A Thread, and a Task with no open work, stay
 * quiet. The result is keyed by the cut work, so a retry adds nothing.
 */
export async function reportPersonStopToParent(
  conversationId: string,
  options: {
    dropped: readonly ParentMessage[];
    queue: ConversationWorkQueue;
    /** The run that the stop asked to stop, if any. */
    runId?: string | undefined;
    state?: StateAdapter | undefined;
  },
): Promise<void> {
  if (
    (!options.runId && options.dropped.length === 0) ||
    !(await readAgentConfig(conversationId))
  ) {
    return;
  }
  const conversation = await getConversationStore().get({ conversationId });
  if (
    !conversation ||
    turnBehavior({ kind: conversation.kind, personInput: false })
      .failureNotice !== "parent"
  ) {
    return;
  }
  const [turn] = options.runId
    ? await listActiveMailboxTurns(conversationId)
    : [];
  const [firstDropped] = options.dropped;
  const turnId =
    turn?.turnId ??
    `stopped:${options.runId ?? firstDropped?.parentToolCallId}`;
  await createDeliverToParent(options)({
    actor: turn?.actor ?? firstDropped?.actor ?? EVENT_SYSTEM_ACTOR,
    conversationId,
    result: { kind: "stopped", text: "A person stopped this task." },
    turnId,
  });
}

/**
 * List one child Conversation and every Conversation below it, child first.
 * It takes the create lock of each Conversation before it reads that
 * Conversation's children, so no child agent can start in the tree until the
 * caller's transaction ends.
 */
async function lockAgentConversationTree(
  childConversationId: string,
): Promise<string[]> {
  const executor = getSqlExecutor();
  const conversationIds = [childConversationId];
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
      .selectDistinct({
        childConversationId: juniorAgentInvocations.childConversationId,
      })
      .from(juniorAgentInvocations)
      .where(inArray(juniorAgentInvocations.parentConversationId, parents));
    // A child agent that no agent invocation names stores its agent config.
    const withoutInvocations = await executor
      .db()
      .select({ childConversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(
        and(
          inArray(juniorConversations.parentConversationId, parents),
          isNotNull(juniorConversations.agentConfig),
        ),
      );
    parents = [
      ...new Set(
        [...rows, ...withoutInvocations].map((row) => row.childConversationId),
      ),
    ].filter((id) => !conversationIds.includes(id));
    conversationIds.push(...parents);
  }
  /* oxlint-enable no-await-in-loop */
  return conversationIds;
}

/**
 * Keep a Conversation, the child agents whose Agent invocation or child
 * Conversation was created after `createdAfterMs`, and every Conversation
 * below those child agents.
 */
async function withChildAgentsCreatedAfter(
  conversationId: string,
  conversationIds: readonly string[],
  createdAfterMs: number,
): Promise<string[]> {
  const links = await getSqlExecutor()
    .db()
    .selectDistinct({
      childConversationId: juniorAgentInvocations.childConversationId,
      parentConversationId: juniorAgentInvocations.parentConversationId,
    })
    .from(juniorAgentInvocations)
    .where(
      and(
        inArray(juniorAgentInvocations.parentConversationId, [
          ...conversationIds,
        ]),
        or(
          ne(juniorAgentInvocations.parentConversationId, conversationId),
          gt(juniorAgentInvocations.createdAt, new Date(createdAfterMs)),
        ),
      ),
    );
  // A stopped parent gives a child agent that no Agent invocation names no
  // work, so only a spawn that raced the stop created one after it.
  const withoutInvocations = await getSqlExecutor()
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
    for (const link of [...links, ...withoutInvocations]) {
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
 * Stop the agent invocations of one direct child agent and of every child
 * agent below it. Returns undefined when the child does not belong to the
 * parent.
 */
export async function stopChildAgentInvocations(args: {
  childConversationId: string;
  nowMs?: number;
  parentConversationId: string;
}): Promise<StoppedAgentTree | undefined> {
  const db = getSqlExecutor().db();
  const [owned, child] = await Promise.all([
    db
      .select({ invocationId: juniorAgentInvocations.invocationId })
      .from(juniorAgentInvocations)
      .where(
        and(
          eq(
            juniorAgentInvocations.parentConversationId,
            args.parentConversationId,
          ),
          eq(
            juniorAgentInvocations.childConversationId,
            args.childConversationId,
          ),
        ),
      )
      .limit(1),
    // A child agent that no agent invocation names stores its agent config.
    db
      .select({ conversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(
        and(
          eq(juniorConversations.conversationId, args.childConversationId),
          eq(
            juniorConversations.parentConversationId,
            args.parentConversationId,
          ),
          isNotNull(juniorConversations.agentConfig),
        ),
      ),
  ]);
  if (owned.length === 0 && child.length === 0) {
    return undefined;
  }
  return await stopAgentInvocationTree(args.childConversationId, args.nowMs);
}

/** The Conversations of a stopped tree and the agent invocations it stopped. */
export type StoppedAgentTree = {
  conversationIds: string[];
  stopped: TerminalAgentInvocation[];
};

/**
 * Stop the agent invocations of one agent Conversation and of every child
 * agent below it. Open agent invocations become `stopped`. Results that would
 * still start or report work in the tree become `skipped`. With
 * `includeRoot: false`, the agent invocations of the Conversation itself stay
 * as they are, and only `pending` results sent to it become `skipped`. With
 * `createdAfterMs`, only the direct child agents whose Agent invocation or
 * child Conversation was created after that time, and the Conversations
 * below them, stop.
 */
export async function stopAgentInvocationTree(
  conversationId: string,
  nowMs = Date.now(),
  options: { createdAfterMs?: number; includeRoot: boolean } = {
    includeRoot: true,
  },
): Promise<StoppedAgentTree> {
  // One transaction holds the create locks of the tree until every write is
  // done. A child agent that starts later finds its parent stopped.
  return await getSqlExecutor().withLock(
    getChildAgentLockName(conversationId),
    () => stopLockedAgentInvocationTree(conversationId, nowMs, options),
  );
}

async function stopLockedAgentInvocationTree(
  conversationId: string,
  nowMs: number,
  options: { createdAfterMs?: number; includeRoot: boolean },
): Promise<StoppedAgentTree> {
  const db = getSqlExecutor().db();
  const now = new Date(nowMs);
  const lockedIds = await lockAgentConversationTree(conversationId);
  const conversationIds =
    options.createdAfterMs === undefined
      ? lockedIds
      : await withChildAgentsCreatedAfter(
          conversationId,
          lockedIds,
          options.createdAfterMs,
        );
  const stoppedChildIds = options.includeRoot
    ? conversationIds
    : conversationIds.filter((id) => id !== conversationId);
  // Stop open work first. After this write no agent invocation in the tree
  // can finish, so no new result can appear.
  const stopped = await db
    .update(juniorAgentInvocations)
    .set({
      errorMessage: "Stopped by the parent conversation",
      parentMailboxStatus: "skipped",
      result: null,
      status: "stopped",
      terminalAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(juniorAgentInvocations.childConversationId, stoppedChildIds),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    )
    .returning();
  await db
    .update(juniorAgentInvocations)
    .set({ parentMailboxStatus: "skipped", updatedAt: now })
    .where(
      or(
        // A result sent to the tree would start new work there.
        and(
          inArray(juniorAgentInvocations.parentConversationId, stoppedChildIds),
          inArray(juniorAgentInvocations.parentMailboxStatus, [
            "pending",
            "appended",
          ]),
        ),
        // With `includeRoot: false`, an `appended` result sent to the
        // Conversation can be one that it already read, so only `pending`
        // results are skipped here. See `skipUnreadResults`.
        and(
          eq(juniorAgentInvocations.parentConversationId, conversationId),
          eq(juniorAgentInvocations.parentMailboxStatus, "pending"),
        ),
        // No later agent invocation in the tree sends a `replaced` report.
        and(
          inArray(juniorAgentInvocations.childConversationId, stoppedChildIds),
          eq(juniorAgentInvocations.parentMailboxStatus, "replaced"),
        ),
      ),
    );
  return {
    conversationIds,
    stopped: stopped.map(invocationFromRow).filter(isTerminalAgentInvocation),
  };
}
