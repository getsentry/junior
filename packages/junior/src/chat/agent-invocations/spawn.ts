import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import type {
  AgentRunRequest,
  AgentSpawnControl,
  AgentSpawnInput,
  AgentSpawnResult,
} from "@/chat/agent/request";
import {
  actorFromRouting,
  toolInvocationDestination,
} from "@/chat/agent/request";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { CreateAgentInvocationInput } from "./types";
import { createAndEnqueueAgentInvocation } from "./work";

export interface AgentInvocationCreator {
  create(input: CreateAgentInvocationInput): Promise<AgentSpawnResult>;
}

interface AgentInvocationCreatorOptions {
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue | (() => ConversationWorkQueue);
  state?: StateAdapter;
}

/** Create the narrow durable invocation capability used by agent runners. */
export function createAgentInvocationCreator(
  options: AgentInvocationCreatorOptions,
): AgentInvocationCreator {
  return {
    async create(input) {
      const queue =
        typeof options.queue === "function" ? options.queue() : options.queue;
      const created = await createAndEnqueueAgentInvocation(input, {
        ...options,
        queue,
      });
      return {
        agentName: created.invocation.agentName,
        childConversationId: created.invocation.childConversationId,
        invocationId: created.invocation.invocationId,
        replayed: created.status === "existing",
        status: created.invocation.status,
      };
    },
  };
}

/** Bind one run's runtime-owned authority to the model-safe spawn capability. */
export function bindAgentSpawnControl(
  request: AgentRunRequest,
  creator: AgentInvocationCreator,
): AgentSpawnControl | undefined {
  const actor = actorFromRouting(request.routing);
  if (!actor) {
    return undefined;
  }
  return {
    async execute(
      input: AgentSpawnInput,
      options: { signal?: AbortSignal; toolCallId: string },
    ) {
      options.signal?.throwIfAborted();
      return await creator.create({
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
        idempotencyKey: `${request.turnId}:${options.toolCallId}`,
        input: input.task,
        parentConversationId: request.conversationId,
        ...(input.reasoningLevel
          ? { reasoningLevel: input.reasoningLevel }
          : {}),
        source: request.routing.source,
      });
    },
  };
}
