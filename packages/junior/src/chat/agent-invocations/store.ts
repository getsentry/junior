import { readAgentConfig } from "@/chat/conversations/agent-config";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { readInboundMessageSender } from "@/chat/task-execution/message-sender";
import { readChildConversationSender } from "./child-input";
import { listOpenChildAgents } from "./list";

/**
 * Read the name, agent type, fork flag, and title of one child Conversation,
 * for labels, from its binding, title, and agent config.
 */
export async function getChildAgentLabel(childConversationId: string) {
  const [sender, options] = await Promise.all([
    readChildConversationSender(childConversationId),
    readAgentConfig(childConversationId),
  ]);
  return sender && options
    ? {
        agentName: sender.agentName ?? null,
        agentType: options.agentType ?? null,
        fork: options.fork ?? false,
        title: sender.title ?? null,
      }
    : undefined;
}

/**
 * Return whether a child agent still works when its Turn sends a `reply`:
 * one of its own child agents has open work, or a reply or message from one
 * of them waits in its mailbox. That reply then goes to the parent as a
 * message, not as the child's result.
 */
export async function childAgentStillWorks(
  conversationId: string,
): Promise<boolean> {
  if ((await listOpenChildAgents(conversationId)).length > 0) {
    return true;
  }
  const work = await getConversationWorkState({ conversationId });
  return (work?.messages ?? []).some(
    (message) => readInboundMessageSender(message) !== undefined,
  );
}
