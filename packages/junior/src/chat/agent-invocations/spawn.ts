import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import type {
  AgentRunRequest,
  SpawnAgent,
  SpawnAgentInput,
} from "@/chat/agent/request";
import {
  actorFromRouting,
  toolInvocationDestination,
} from "@/chat/agent/request";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { createAndEnqueueAgentInvocation } from "./work";

type SpawnOptions = {
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue | (() => ConversationWorkQueue);
  state?: StateAdapter;
};

/** Bind one run's runtime-owned authority to the model-safe spawn capability. */
export function bindSpawnAgent(
  request: AgentRunRequest,
  options: SpawnOptions,
): SpawnAgent | undefined {
  const actor = actorFromRouting(request.routing);
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
        ...(input.name ? { agentName: input.name } : {}),
        ...(request.routing.credentialContext
          ? { credentialContext: request.routing.credentialContext }
          : {}),
        destination: toolInvocationDestination(request.routing),
        ...(request.routing.destinationVisibility
          ? {
              destinationVisibility: request.routing.destinationVisibility,
            }
          : {}),
        idempotencyKey: `${request.turnId}:${call.toolCallId}`,
        input: input.task,
        parentConversationId: request.conversationId,
        ...(input.reasoningLevel
          ? { reasoningLevel: input.reasoningLevel }
          : {}),
        source: request.routing.source,
      },
      { ...options, queue },
    );
    return { invocationId: invocation.invocationId };
  };
}
