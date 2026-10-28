import { eq, inArray } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { isEventMailboxMetadata } from "@/chat/events/notification";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { juniorConversations } from "@/db/schema";

/**
 * Record a session stop on each Conversation. Call this after their watches
 * end: a watch delivers under its lock, so every event from a cancelled watch
 * was received before this time.
 */
export async function markConversationsStopped(
  conversationIds: readonly string[],
  nowMs = Date.now(),
): Promise<void> {
  if (conversationIds.length === 0) {
    return;
  }
  await getSqlExecutor()
    .db()
    .update(juniorConversations)
    .set({ stoppedAt: new Date(nowMs) })
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));
}

/** Return when a Conversation's session was last stopped. */
export async function getConversationStoppedAtMs(
  conversationId: string,
): Promise<number | undefined> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ stoppedAt: juniorConversations.stoppedAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row?.stoppedAt?.getTime();
}

/**
 * Drop watch events, agent results, and agent messages received at or before
 * the Conversation's last session stop. Input from a person or a parent tool
 * call always runs. Returns undefined when the work should run.
 */
export async function skipInputBeforeConversationStop(
  context: ConversationWorkerContext,
): Promise<ConversationWorkerResult | undefined> {
  const messages = context.attempt.messages;
  if (
    messages.length === 0 ||
    !messages.every(
      (message) =>
        message.source === "event" &&
        isEventMailboxMetadata(message.input.metadata),
    )
  ) {
    return undefined;
  }
  const stoppedAtMs = await getConversationStoppedAtMs(context.conversationId);
  if (
    stoppedAtMs === undefined ||
    messages.some((message) => message.receivedAtMs > stoppedAtMs)
  ) {
    return undefined;
  }
  await context.attempt.ack();
  return { status: "completed" };
}
