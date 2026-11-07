import { readChildDepthAndRootLocation } from "@/chat/agent-invocations/lineage";
import { getConversationStore } from "@/chat/db";
import { assertRunConsistency, type AgentRun } from "./types";

type ConsistencyRun = Parameters<typeof assertRunConsistency>[0];

/**
 * Return the root of a Run's Conversation when it is a Thread and the Run's
 * web Source has another local Destination. Only that case needs the root.
 */
async function readThreadRootConversationId(
  run: Pick<AgentRun, "conversationId" | "destination" | "source">,
): Promise<string | undefined> {
  if (
    run.source.kind !== "web" ||
    run.source.conversationId !== run.conversationId ||
    run.destination.platform !== "local" ||
    run.destination.conversationId === run.source.conversationId
  ) {
    return undefined;
  }
  const conversation = await getConversationStore().get({
    conversationId: run.conversationId,
  });
  if (conversation?.kind !== "thread") {
    return undefined;
  }
  const { root } = await readChildDepthAndRootLocation(run.conversationId);
  return root?.conversationId;
}

/** Reject contradictory provider coordinates, with a Thread's stored root. */
export async function checkRunConsistency(run: ConsistencyRun): Promise<void> {
  assertRunConsistency(run, {
    threadRootConversationId: await readThreadRootConversationId(run),
  });
}
