import { and, eq, inArray, or } from "drizzle-orm";
import type { StateAdapter } from "chat";
import {
  getConversationStoppedAtMs,
  markConversationsStopped,
} from "@/chat/conversations/session-stop";
import { getSqlExecutor } from "@/chat/db";
import { stopConversationTurn } from "@/chat/conversations/stop";
import { cancelSubscriptions } from "@/chat/events/store";
import type { AgentRun, StopAgent } from "@/chat/agent/types";
import { cancelSignInPausedTurn } from "@/chat/task-execution/conversation-turn";
import { getAuthPausedConversationTurnId } from "@/chat/task-execution/mailbox-turn";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
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

/** Bind a Run's Conversation and the queue of its child work to stopAgent. */
export function bindStopAgent(
  run: Pick<AgentRun, "conversationId">,
  options: {
    queue: ConversationWorkQueue | (() => ConversationWorkQueue);
    state?: StateAdapter;
  },
): StopAgent {
  return async (childConversationId) =>
    await stopChildAgent({
      childConversationId,
      parentConversationId: run.conversationId,
      queue:
        typeof options.queue === "function" ? options.queue() : options.queue,
      state: options.state,
    });
}

/**
 * Stop one child agent of a parent Conversation and every child agent below
 * it. The parent gets no result. SQL stops the work first. Then each
 * Conversation in the tree ends its session, and a Conversation stop request
 * aborts each run that is still working.
 *
 * Returns undefined when the child does not belong to the parent.
 */
export async function stopChildAgent(args: {
  childConversationId: string;
  parentConversationId: string;
  queue: ConversationWorkQueue;
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
  await finishStoppedTree(tree, tree.conversationIds, args);
  return { stopped: tree.stopped.length > 0 || !wasStopped };
}

/**
 * Stop a root Conversation's session the same way `stopAgent` stops a child:
 * its child agents stop, and it ends its own session. The caller interrupts
 * its own run.
 */
export async function stopConversationSession(args: {
  conversationId: string;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<void> {
  await stopChildAgentsOf(args.conversationId, args);
  await endSessions([args.conversationId], args.state);
}

/**
 * Stop the child agents of an agent Conversation that a stop interrupted.
 * The worker of that Conversation calls this after it records its own stop,
 * so this sends no stop request to that Conversation.
 */
export async function stopChildAgentsOf(
  conversationId: string,
  options: StopWorkOptions,
): Promise<void> {
  const tree = await stopAgentInvocationTree(conversationId);
  await finishStoppedTree(
    tree,
    tree.conversationIds.filter((id) => id !== conversationId),
    options,
  );
}

type StopWorkOptions = { queue: ConversationWorkQueue; state?: StateAdapter };

/**
 * A Thread can hold a person's Turn that waits for sign-in. The stop ends
 * that Turn here, not in the stop wake, because the wake can go to queued
 * input first. Then a later sign-in callback cannot resume a stopped Thread.
 */
async function finishStoppedTree(
  tree: StoppedAgentTree,
  conversationIdsToStop: string[],
  options: StopWorkOptions,
): Promise<void> {
  for (const invocation of tree.stopped) {
    await recordSubagentEnded(invocation);
  }
  await endSessions(conversationIdsToStop, options.state);
  for (const conversationId of conversationIdsToStop) {
    const pausedTurnId = await getAuthPausedConversationTurnId(conversationId);
    if (pausedTurnId) {
      await cancelSignInPausedTurn({ conversationId, turnId: pausedTurnId });
    }
    await stopConversationTurn({
      conversationId,
      queue: options.queue,
      state: options.state,
    });
  }
}

/**
 * End each Conversation's watches, then record the stop, so the worker drops
 * every event those watches delivered.
 */
async function endSessions(
  conversationIds: string[],
  state: StateAdapter | undefined,
): Promise<void> {
  for (const conversationId of conversationIds) {
    await cancelSubscriptions({ conversationId, state });
  }
  await markConversationsStopped(conversationIds);
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
 * still start or report work in the tree become `skipped`.
 */
export async function stopAgentInvocationTree(
  conversationId: string,
  nowMs = Date.now(),
): Promise<StoppedAgentTree> {
  // One transaction holds the create locks of the tree until every write is
  // done. A child agent that starts later finds its parent stopped.
  return await getSqlExecutor().withLock(
    getChildAgentLockName(conversationId),
    () => stopLockedAgentInvocationTree(conversationId, nowMs),
  );
}

async function stopLockedAgentInvocationTree(
  conversationId: string,
  nowMs: number,
): Promise<StoppedAgentTree> {
  const db = getSqlExecutor().db();
  const now = new Date(nowMs);
  const conversationIds = await lockAgentConversationTree(conversationId);
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
        inArray(juniorAgentInvocations.childConversationId, conversationIds),
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
          inArray(juniorAgentInvocations.parentConversationId, conversationIds),
          inArray(juniorAgentInvocations.parentMailboxStatus, [
            "pending",
            "appended",
          ]),
        ),
        // No later agent invocation in the tree sends a `replaced` report.
        and(
          inArray(juniorAgentInvocations.childConversationId, conversationIds),
          eq(juniorAgentInvocations.parentMailboxStatus, "replaced"),
        ),
      ),
    );
  return {
    conversationIds,
    stopped: stopped.map(invocationFromRow).filter(isTerminalAgentInvocation),
  };
}
