import { and, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { StateAdapter } from "chat";
import {
  getConversationStoppedAtMs,
  markConversationsStopped,
} from "@/chat/conversations/session-stop";
import { getSqlExecutor } from "@/chat/db";
import { cancelSignInWait } from "@/chat/task-execution/turn-cancel";
import {
  dropPendingMessages,
  getConversationWorkState,
  stopConversationWork,
} from "@/chat/task-execution/store";
import { juniorAgentInvocations, juniorConversations } from "@/db/schema";
import { recordSubagentEnded } from "./markers";
import { isChildAgentSessionStopped } from "./list";
import {
  getChildAgentLockName,
  parseAgentInvocationResultMessageId,
  parseAgentReplyMessageId,
  parseChildReplyMessageId,
  parseTurnReplyMessageId,
} from "./ids";
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
  const latest = await getLatestAgentInvocationForConversation(
    args.childConversationId,
  );
  const wasStopped =
    latest !== undefined &&
    (latest.status === "stopped" ||
      isChildAgentSessionStopped(
        latest,
        await getConversationStoppedAtMs(args.childConversationId),
      ));
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
 * Conversation spawned or gave new work to after its stop, even when they
 * already finished, and everything below them. When the stop already ended,
 * because a person or the parent gave the Conversation new input, this does
 * nothing.
 *
 * Only a person's stop of this Conversation itself leaves child agents to
 * stop here: an agent stop, or a stop of a Conversation above it, stops this
 * Conversation's own agent invocations first, so it cannot spawn more. So
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
    includeRoot: false,
    taskedAfterMs: stoppedAtMs,
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
 * Conversation's own agent invocations stay as they are: when it is a child
 * agent, its worker records the stop and reports it to its parent. Call it
 * through `stopConversation`, which stops the Conversation's Turn next.
 *
 * The Conversation's run sees its stop only at its next stop signal check.
 * When it does, `stopChildAgentsOf` stops the child agents that it spawned or
 * gave new work to before then, at the time of this stop. So input that ends
 * this stop ends theirs too.
 */
export async function stopChildAgentsBelow(
  conversationId: string,
  options: { nowMs: number; stoppedAtMs: number; state?: StateAdapter },
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
  const invocationIds = messages.flatMap((message) => {
    const invocationId =
      parseAgentInvocationResultMessageId(message.inboundMessageId) ??
      (parseTurnReplyMessageId(message.inboundMessageId) === undefined
        ? parseAgentReplyMessageId(message.inboundMessageId)
        : undefined);
    return invocationId ? [invocationId] : [];
  });
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
 * Conversations left in each mailbox of `mailboxIds`. Such a reply names the
 * sender's newest finished agent invocation, not work that the stop skips,
 * so the stop drops it by its message id. A reply sent after the stop is
 * dropped when it is read, while the sender is stopped. Call this after the
 * stop is stored.
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
  for (const conversationId of mailboxIds) {
    const messages =
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    const replies = messages.flatMap((message) => {
      const invocationId =
        parseTurnReplyMessageId(message.inboundMessageId) === undefined
          ? undefined
          : parseAgentReplyMessageId(message.inboundMessageId);
      return invocationId
        ? [{ invocationId, messageId: message.inboundMessageId }]
        : [];
    });
    // A reply from a child that no agent invocation names names its child
    // Conversation.
    const childReplies = messages.filter((message) => {
      const childConversationId = parseChildReplyMessageId(
        message.inboundMessageId,
      );
      return (
        childConversationId !== undefined && stopped.has(childConversationId)
      );
    });
    const senders =
      replies.length === 0
        ? []
        : await getSqlExecutor()
            .db()
            .select({
              childConversationId: juniorAgentInvocations.childConversationId,
              invocationId: juniorAgentInvocations.invocationId,
            })
            .from(juniorAgentInvocations)
            .where(
              inArray(
                juniorAgentInvocations.invocationId,
                replies.map((reply) => reply.invocationId),
              ),
            );
    const stoppedSenders = new Set(
      senders
        .filter((sender) => stopped.has(sender.childConversationId))
        .map((sender) => sender.invocationId),
    );
    const inboundMessageIds = [
      ...replies
        .filter((reply) => stoppedSenders.has(reply.invocationId))
        .map((reply) => reply.messageId),
      ...childReplies.map((message) => message.inboundMessageId),
    ];
    if (inboundMessageIds.length > 0) {
      await dropPendingMessages({ conversationId, inboundMessageIds, state });
    }
  }
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
    await recordSubagentEnded(invocation);
  }
  await markConversationsStopped(conversationIdsToStop, options);
  for (const conversationId of conversationIdsToStop) {
    await cancelSignInWait(conversationId);
    await stopConversationWork({ conversationId, state: options.state });
  }
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
    // A child agent that no agent invocation names stores its spawn options.
    const withoutInvocations = await executor
      .db()
      .select({ childConversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(
        and(
          inArray(juniorConversations.parentConversationId, parents),
          isNotNull(juniorConversations.spawnOptions),
        ),
      );
    parents = [
      ...new Set(
        [...rows, ...withoutInvocations].map((row) => row.childConversationId),
      ),
    ].filter((id) => !conversationIds.includes(id));
    conversationIds.push(...parents);
  }
  return conversationIds;
}

/**
 * Keep a Conversation, the child agents that it spawned or gave new work to
 * after `taskedAfterMs`, and every Conversation below those child agents.
 */
async function withChildAgentsTaskedAfter(
  conversationId: string,
  conversationIds: readonly string[],
  taskedAfterMs: number,
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
          gt(juniorAgentInvocations.createdAt, new Date(taskedAfterMs)),
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
    // A child agent that no agent invocation names stores its spawn options.
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
          isNotNull(juniorConversations.spawnOptions),
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
 * `taskedAfterMs`, only the direct child agents that got an agent invocation
 * after that time, and the Conversations below them, stop.
 */
export async function stopAgentInvocationTree(
  conversationId: string,
  nowMs = Date.now(),
  options: { includeRoot: boolean; taskedAfterMs?: number } = {
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
  options: { includeRoot: boolean; taskedAfterMs?: number },
): Promise<StoppedAgentTree> {
  const db = getSqlExecutor().db();
  const now = new Date(nowMs);
  const lockedIds = await lockAgentConversationTree(conversationId);
  const conversationIds =
    options.taskedAfterMs === undefined
      ? lockedIds
      : await withChildAgentsTaskedAfter(
          conversationId,
          lockedIds,
          options.taskedAfterMs,
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
