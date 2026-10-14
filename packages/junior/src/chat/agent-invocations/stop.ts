import type { StateAdapter } from "chat";
import { stopConversationWork } from "@/chat/task-execution/store";
import { recordSubagentEnded } from "./markers";
import { and, eq, inArray, or } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations } from "@/db/schema";
import {
  getChildAgentLockName,
  invocationFromRow,
  isTerminalAgentInvocation,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
} from "./store";
import type { TerminalAgentInvocation } from "./types";

/**
 * Stop one child agent of a parent Conversation and every child agent below
 * it. The parent gets no result. SQL stops the work first. Then a
 * Conversation stop request aborts each run that is still working.
 *
 * Returns undefined when the child does not belong to the parent.
 */
export async function stopChildAgent(args: {
  childConversationId: string;
  parentConversationId: string;
  state?: StateAdapter;
}): Promise<{ stoppedCount: number } | undefined> {
  const tree = await stopChildAgentInvocations(args);
  if (!tree) {
    return undefined;
  }
  await finishStoppedTree(tree, tree.conversationIds, args.state);
  return { stoppedCount: tree.stopped.length };
}

/**
 * Stop the child agents of an agent Conversation that a stop interrupted.
 * The worker of that Conversation calls this after it records its own stop,
 * so this sends no stop request to that Conversation.
 */
export async function stopChildAgentsOf(
  conversationId: string,
  state?: StateAdapter,
): Promise<void> {
  const tree = await stopAgentInvocationTree(conversationId);
  await finishStoppedTree(
    tree,
    tree.conversationIds.filter((id) => id !== conversationId),
    state,
  );
}

async function finishStoppedTree(
  tree: StoppedAgentTree,
  conversationIdsToStop: string[],
  state: StateAdapter | undefined,
): Promise<void> {
  for (const invocation of tree.stopped) {
    await recordSubagentEnded(invocation);
  }
  for (const conversationId of conversationIdsToStop) {
    await stopConversationWork({ conversationId, state });
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
