import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import type { AgentRun, SpawnAgent, SpawnAgentInput } from "@/chat/agent/types";
import { actorFromRun, toolInvocationDestination } from "@/chat/agent/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { createAndEnqueueAgentInvocation } from "./work";

type SpawnOptions = {
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue | (() => ConversationWorkQueue);
  state?: StateAdapter;
};

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
    const queue =
      typeof options.queue === "function" ? options.queue() : options.queue;
    const invocation = await createAndEnqueueAgentInvocation(
      {
        actor,
        ...(input.name ? { agentName: input.name } : undefined),
        ...(run.credentialContext
          ? { credentialContext: run.credentialContext }
          : undefined),
        destination: toolInvocationDestination(run),
        idempotencyKey: `${run.turnId}:${call.toolCallId}`,
        input: input.task,
        parentConversationId: run.conversationId,
        ...(input.reasoningLevel
          ? { reasoningLevel: input.reasoningLevel }
          : undefined),
        source: run.source,
      },
      { ...options, queue },
    );
    return { invocationId: invocation.invocationId };
  };
}
