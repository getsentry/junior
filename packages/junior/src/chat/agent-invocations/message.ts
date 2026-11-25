import type { StateAdapter } from "chat";
import type { ConversationStore } from "@/chat/conversations/store";
import type {
  AgentRun,
  MessageAgent,
  MessageAgentInput,
} from "@/chat/agent/types";
import { actorFromRun } from "@/chat/agent/types";
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { findChildAgentConversationId } from "./bindings";
import { readChildConversationSender } from "./child-input";
import { AgentMessageTargetError } from "./errors";
import { enqueueAgentMessageToParent } from "./result";
import { messageChildAgent } from "./create";
import { enqueueTopLevelAgentMessage } from "./top-level-message";
import { steeringSenderForRun } from "./steering-sender";
import { PARENT_AGENT_TARGET } from "./types";

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
  const steeringSender = steeringSenderForRun(run);
  return async (
    input: MessageAgentInput,
    call: { signal?: AbortSignal; toolCallId: string },
  ) => {
    call.signal?.throwIfAborted();
    const queue =
      typeof options.queue === "function" ? options.queue() : options.queue;
    if (input.to === PARENT_AGENT_TARGET) {
      const sender = await readChildConversationSender(run.conversationId);
      if (!sender) {
        throw new AgentMessageTargetError(
          "This conversation has no parent agent",
        );
      }
      await enqueueAgentMessageToParent({
        actor,
        messageKey: `${run.turnId}:${call.toolCallId}`,
        queue,
        sender,
        state: options.state,
        steeringSender,
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
        askingActor: isPersonInput(run.source.kind) ? actor : undefined,
        messageKey: `${run.turnId}:${call.toolCallId}`,
        queue,
        senderConversationId: run.conversationId,
        state: options.state,
        steeringSender,
        text: input.text,
        to: input.to,
      });
      return { conversationId: input.to, delivery: "queued" };
    }
    const { delivery } = await messageChildAgent(
      {
        actor,
        childConversationId,
        ...(run.credentialContext
          ? { credentialContext: run.credentialContext }
          : undefined),
        idempotencyKey: `${run.turnId}:${call.toolCallId}`,
        input: input.text,
        parentConversationId: run.conversationId,
        parentToolCallId: call.toolCallId,
        parentTurnId: run.turnId,
      },
      { ...options, queue },
    );
    return { conversationId: childConversationId, delivery };
  };
}
