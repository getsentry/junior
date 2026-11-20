import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import type { AgentRun, SpawnAgent, SpawnAgentInput } from "@/chat/agent/types";
import { actorFromRun, toolInvocationDestination } from "@/chat/agent/types";
import { botConfig } from "@/chat/config";
import { readConversationLineage } from "@/chat/conversations/lineage";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { spawnChildAgent } from "./create";
import { AgentDepthLimitError } from "./errors";
import { getAgentInvocationId } from "./ids";
import { getAgentInvocation } from "./store";
import { createAndEnqueueAgentInvocation } from "./work";

type SpawnOptions = {
  conversationStore?: ConversationStore;
  /**
   * How many levels of child agents can start their own child agents. The
   * default comes from `limits.maxAgentDepth`. 0 lets only the root start them.
   */
  maxAgentDepth?: number;
  queue: ConversationWorkQueue | (() => ConversationWorkQueue);
  state?: StateAdapter;
};

/**
 * Count the parents of the Conversation that starts a child agent. A chain
 * that does not end at a root, such as a cycle, cannot start one.
 */
async function assertCanStartChildAgent(
  conversationId: string,
  maxAgentDepth: number,
): Promise<void> {
  const lineage = await readConversationLineage(conversationId);
  const root = lineage[0];
  if (
    !root ||
    root.parentConversationId ||
    lineage.length - 1 > maxAgentDepth
  ) {
    throw new AgentDepthLimitError(maxAgentDepth);
  }
}

/** Bind a Run's Actor and credentials to new Agent invocations. */
export function bindSpawnAgent(
  run: AgentRun,
  options: SpawnOptions,
): SpawnAgent | undefined {
  const actor = actorFromRun(run);
  if (!actor) {
    return undefined;
  }
  return async (
    input: SpawnAgentInput,
    call: { signal?: AbortSignal; toolCallId: string },
  ) => {
    call.signal?.throwIfAborted();
    await assertCanStartChildAgent(
      run.conversationId,
      options.maxAgentDepth ?? botConfig.maxAgentDepth,
    );
    const idempotencyKey = `${run.turnId}:${call.toolCallId}`;
    const queue =
      typeof options.queue === "function" ? options.queue() : options.queue;
    const createInput = {
      actor,
      ...(input.name ? { agentName: input.name } : undefined),
      ...(input.agentType ? { agentType: input.agentType } : undefined),
      ...(input.fork ? { fork: true as const } : undefined),
      ...(run.credentialContext
        ? { credentialContext: run.credentialContext }
        : undefined),
      destination: toolInvocationDestination(run),
      idempotencyKey,
      input: input.task,
      ...(input.kind ? { kind: input.kind } : undefined),
      parentConversationId: run.conversationId,
      parentToolCallId: call.toolCallId,
      ...(input.reasoningLevel
        ? { reasoningLevel: input.reasoningLevel }
        : undefined),
      ...(input.title ? { title: input.title } : undefined),
    };
    // TODO(dcramer): Delete with Agent invocation rows (#3060 step 7). A spawn
    // that wrote an Agent invocation before this release replays through it.
    if (
      await getAgentInvocation(
        getAgentInvocationId(run.conversationId, idempotencyKey),
      )
    ) {
      const invocation = await createAndEnqueueAgentInvocation(createInput, {
        ...options,
        queue,
      });
      return { childConversationId: invocation.childConversationId };
    }
    return await spawnChildAgent(
      { ...createInput, parentTurnId: run.turnId },
      { ...options, queue },
    );
  };
}
