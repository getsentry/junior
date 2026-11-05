import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import type {
  AgentRun,
  MessageAgent,
  MessageAgentInput,
} from "@/chat/agent/types";
import { actorFromRun, toolInvocationDestination } from "@/chat/agent/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { findChildAgentConversationId } from "./bindings";
import { AgentMessageTargetError } from "./errors";
import { enqueueAgentMessageToParent } from "./result";
import {
  createAgentInvocationForMessage,
  getActiveAgentInvocationForConversation,
} from "./store";
import { enqueueTopLevelAgentMessage } from "./top-level-message";
import { PARENT_AGENT_TARGET } from "./types";
import { enqueueAgentInvocation } from "./work";

type MessageOptions = {
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue | (() => ConversationWorkQueue);
  state?: StateAdapter;
};

/**
 * Bind a Run's Actor and credentials to messages for its parent and child
 * agents, and for other top-level agents. A message to a child continues that
 * child. A message to the parent wakes the parent like a result. A top-level
 * agent can also message another top-level agent that it has access to.
 */
export function bindMessageAgent(
  run: AgentRun,
  options: MessageOptions,
): MessageAgent | undefined {
  const actor = actorFromRun(run);
  if (!actor) {
    return undefined;
  }
  return async (
    input: MessageAgentInput,
    call: { signal?: AbortSignal; toolCallId: string },
  ) => {
    call.signal?.throwIfAborted();
    const queue =
      typeof options.queue === "function" ? options.queue() : options.queue;
    if (input.to === PARENT_AGENT_TARGET) {
      const sender = await getActiveAgentInvocationForConversation(
        run.conversationId,
      );
      if (!sender) {
        throw new AgentMessageTargetError(
          "This conversation has no parent agent",
        );
      }
      await enqueueAgentMessageToParent({
        messageKey: `${run.turnId}:${call.toolCallId}`,
        queue,
        sender,
        state: options.state,
        text: input.text,
      });
      return {
        conversationId: sender.parentConversationId,
        delivery: "queued",
      };
    }
    const childConversationId = await findChildAgentConversationId({
      parentConversationId: run.conversationId,
      target: input.to,
    });
    if (!childConversationId) {
      await enqueueTopLevelAgentMessage({
        messageKey: `${run.turnId}:${call.toolCallId}`,
        queue,
        senderConversationId: run.conversationId,
        state: options.state,
        text: input.text,
        to: input.to,
      });
      return { conversationId: input.to, delivery: "queued" };
    }
    const { invocation, queued } = await createAgentInvocationForMessage({
      actor,
      childConversationId,
      ...(run.credentialContext
        ? { credentialContext: run.credentialContext }
        : undefined),
      destination: toolInvocationDestination(run),
      idempotencyKey: `${run.turnId}:${call.toolCallId}`,
      input: input.text,
      parentConversationId: run.conversationId,
      parentToolCallId: call.toolCallId,
    });
    await enqueueAgentInvocation(invocation, { ...options, queue });
    return {
      conversationId: childConversationId,
      delivery: queued ? "queued" : "started",
    };
  };
}
