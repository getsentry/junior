import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ConversationEvent } from "@/chat/conversations/history";
import { openConversationProjection } from "@/chat/conversations/projection";
import { juniorConversationEvents } from "@/db/schema";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentInvocation } from "./types";

/** Instructions that a fork child reads with its first task. */
export const FORK_INSTRUCTIONS =
  "You are a fork of your parent agent. The messages before your first parent task are copied from the parent's conversation so you have its context. They are not your job: your job is the parent task below. Sandbox files, approvals, and credentials of the parent were not copied, and your sandbox is separate. Verify files in your own sandbox before you use them.";

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

// The child commits that start history in its first Turn, with the parent's
// timestamps. So it comes after the first `turn_started` but is older than
// it. A Turn's own agent history cannot be older than the Turn. The parent
// Conversation already shows and counts the inherited history.

/** True for agent history that a fork child inherited from its parent. */
export function isInheritedForkHistory(
  event: ConversationEvent,
  firstTurnStart: ConversationEvent | undefined,
): boolean {
  return (
    firstTurnStart !== undefined &&
    event.seq > firstTurnStart.seq &&
    event.createdAtMs < firstTurnStart.createdAtMs &&
    (event.data.type === "assistant_message" ||
      event.data.type === "tool_result")
  );
}

const firstTurn = alias(juniorConversationEvents, "first_turn");

/**
 * SQL filter for event rows that a fork child did not inherit from its
 * parent. Usage reports use it, so inherited model calls count only in the
 * parent.
 */
export function notInheritedByForkChild(): SQL {
  return sql`not coalesce(${juniorConversationEvents.createdAt} < (
    select ${firstTurn.createdAt}
    from ${juniorConversationEvents} as ${sql.identifier("first_turn")}
    where ${firstTurn.conversationId} = ${juniorConversationEvents.conversationId}
      and ${firstTurn.type} = 'turn_started'
      and ${firstTurn.seq} < ${juniorConversationEvents.seq}
    order by ${firstTurn.seq}
    limit 1
  ), false)`;
}
