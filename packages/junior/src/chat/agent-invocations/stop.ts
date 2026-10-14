import type { StateAdapter } from "chat";
import { stopConversationWork } from "@/chat/task-execution/store";
import { recordSubagentEnded } from "./markers";
import {
  stopAgentInvocationTree,
  stopChildAgentInvocations,
  type StoppedAgentTree,
} from "./store";

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
