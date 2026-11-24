import { readAgentConfig } from "@/chat/conversations/agent-config";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import { waitsOnInboxAnswer } from "@/chat/inbox-items/waiting";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { readInboundMessageSender } from "@/chat/task-execution/message-sender";
import { readChildConversationSender } from "./child-input";
import { listChildAgents, listOpenChildAgents } from "./list";

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
 * one of its own child agents has open work, one of its descendants waits on
 * a person's answer to its Inbox item, or a reply or message from one of
 * them waits in its mailbox. That reply then goes to the parent as a
 * message, not as the child's result.
 */
export async function childAgentStillWorks(
  conversationId: string,
): Promise<boolean> {
  if (
    (await listOpenChildAgents(conversationId)).length > 0 ||
    (await descendantWaitsOnInboxAnswer(conversationId))
  ) {
    return true;
  }
  const work = await getConversationWorkState({ conversationId });
  return (work?.messages ?? []).some(
    (message) => readInboundMessageSender(message) !== undefined,
  );
}

// A descendant that asked a person ends its Turn and stops running, but the
// answer starts its next Turn, so every agent above it still waits on it.
async function descendantWaitsOnInboxAnswer(
  conversationId: string,
): Promise<boolean> {
  const children = (await listChildAgents(conversationId)).filter(
    (child) => child.status !== "stopped",
  );
  const waits = await mapBounded(
    children,
    async (child) =>
      (await waitsOnInboxAnswer(getDb(), child.childConversationId)) ||
      (await descendantWaitsOnInboxAnswer(child.childConversationId)),
  );
  return waits.includes(true);
}
