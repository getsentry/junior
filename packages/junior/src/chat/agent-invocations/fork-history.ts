import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ConversationEvent } from "@/chat/conversations/history";
import {
  commitMessages,
  openConversationProjection,
} from "@/chat/conversations/projection";
import { contextProvenance } from "@/chat/conversations/provenance";
import { getSqlExecutor } from "@/chat/db";
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
function forkHistoryFrom(
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
 * Load the start history of a fork child from its parent Conversation.
 */
async function loadForkHistory(
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

async function hasTurnStarted(conversationId: string): Promise<boolean> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "turn_started"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Commit the start history of a fork child before its first Turn starts, so
 * the history is below the Turn start. A child that already has agent
 * history, such as on a retry, commits nothing. A child whose Turn already
 * started commits nothing too: the history would be Turn messages, and a
 * parent `reply` in it would read as the Turn's answer. Only a worker that
 * committed fork history after the Turn start leaves such a child.
 */
export async function commitForkHistory(
  args: Pick<
    AgentInvocation,
    "childConversationId" | "parentConversationId" | "parentToolCallId"
  >,
): Promise<void> {
  const child = await openConversationProjection({
    conversationId: args.childConversationId,
  });
  if (
    child.messages.length > 0 ||
    (await hasTurnStarted(args.childConversationId))
  ) {
    return;
  }
  const messages = await loadForkHistory(args);
  if (messages.length === 0) {
    return;
  }
  await commitMessages({
    conversationId: args.childConversationId,
    messages,
    provenance: messages.map(() => contextProvenance),
  });
}

// The child commits that start history before its first `turn_started`,
// with the parent's timestamps. So it is older than the child's first event,
// the input of its first Turn. The child's own agent history
// cannot be older than that event. Children forked before this order commit
// the history after their first `turn_started`, with the same timestamps.
// The parent Conversation already shows and counts the inherited history.

/** True for agent history that a fork child inherited from its parent. */
export function isInheritedForkHistory(
  event: ConversationEvent,
  firstEvent: ConversationEvent | undefined,
): boolean {
  return (
    firstEvent !== undefined &&
    event.seq > firstEvent.seq &&
    event.createdAtMs < firstEvent.createdAtMs &&
    (event.data.type === "assistant_message" ||
      event.data.type === "tool_result")
  );
}

const firstRow = alias(juniorConversationEvents, "first_event");

/**
 * SQL filter for event rows that a fork child did not inherit from its
 * parent. Usage reports use it, so inherited model calls count only in the
 * parent. It reads only a lower seq, the Conversation's first event, so a
 * counted row never changes whether it counts.
 */
export function notInheritedByForkChild(): SQL {
  return sql`not coalesce(${juniorConversationEvents.createdAt} < (
    select ${firstRow.createdAt}
    from ${juniorConversationEvents} as ${sql.identifier("first_event")}
    where ${firstRow.conversationId} = ${juniorConversationEvents.conversationId}
      and ${firstRow.seq} < ${juniorConversationEvents.seq}
    order by ${firstRow.seq}
    limit 1
  ), false)`;
}
