import { and, eq, gt, inArray, ne, or } from "drizzle-orm";
import type { StateAdapter } from "chat";
import {
  getConversationStoppedAtMs,
  markConversationsStopped,
} from "@/chat/conversations/session-stop";
import { getSqlExecutor } from "@/chat/db";
import { cancelSignInWait } from "@/chat/task-execution/conversation-turn";
import { stopConversationWork } from "@/chat/task-execution/store";
import { juniorAgentInvocations } from "@/db/schema";
import { recordSubagentEnded } from "./markers";
import { isChildAgentSessionStopped } from "./list";
import { getChildAgentLockName } from "./ids";
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
  // They take the stop of this Conversation, so input that ends it ends
  // theirs too.
  await finishStoppedTree(
    tree,
    tree.conversationIds.filter((id) => id !== conversationId),
    { cancelWatches: false, nowMs: stoppedAtMs, state },
  );
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
  await finishStoppedTree(
    tree,
    tree.conversationIds.filter((id) => id !== conversationId),
    { cancelWatches: false, nowMs: stoppedAtMs, state },
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
    parents = rows
      .map((row) => row.childConversationId)
      .filter((id) => !conversationIds.includes(id));
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
  const owned = await getSqlExecutor()
    .db()
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
    .limit(1);
  if (owned.length === 0) {
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
 * still start or report work in the tree become `dropped`. With
 * `includeRoot: false`, the agent invocations of the Conversation itself stay
 * as they are, and only `waiting` results sent to it become `dropped`. With
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
  // can finish, so no new result can appear. A stop owes the parent no
  // result, so this saves the same end as `finishAgentInvocation` would,
  // under the tree lock. A result that the tree already sent starts no work:
  // its child is stopped, so `result.ts` skips it.
  const stopped = await db
    .update(juniorAgentInvocations)
    .set({
      errorMessage: "Stopped by the parent conversation",
      // TODO(dcramer): Remove with `parent_mailbox_status`.
      parentMailboxStatus: "steered",
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
  return {
    conversationIds,
    stopped: stopped.map(invocationFromRow).filter(isTerminalAgentInvocation),
  };
}
