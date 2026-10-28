import { openConversationProjection } from "@/chat/conversations/projection";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentInvocation } from "./types";

/**
 * Cut parent history for a fork: everything before the parent's message that
 * started the fork, through the last point where every tool call has its
 * result. A model request with an unanswered tool call fails, and the parent
 * can commit its history in the middle of a tool round.
 */
export function forkHistoryFrom(
  messages: readonly PiMessage[],
  parentToolCallId: string | undefined,
): PiMessage[] {
  const spawnIndex = parentToolCallId
    ? messages.findIndex(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) => part.type === "toolCall" && part.id === parentToolCallId,
          ),
      )
    : -1;
  const before = spawnIndex >= 0 ? messages.slice(0, spawnIndex) : messages;
  const pending = new Set<string>();
  let end = 0;
  for (const [index, message] of before.entries()) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") pending.add(part.id);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
    if (pending.size === 0) end = index + 1;
  }
  return before.slice(0, end);
}

/**
 * Load the start history of a fork child from its parent Conversation. The
 * child commits it as its own history in its first checkpoint, so later
 * agent invocations of the child read it from the child Conversation.
 */
export async function loadForkHistory(
  invocation: Pick<
    AgentInvocation,
    "parentConversationId" | "parentToolCallId"
  >,
): Promise<PiMessage[]> {
  const parent = await openConversationProjection({
    conversationId: invocation.parentConversationId,
  });
  return forkHistoryFrom(parent.messages, invocation.parentToolCallId);
}
