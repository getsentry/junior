/**
 * Read access to a Conversation's durable event log for model-facing tools,
 * under `policies/conversation-access.md`. The current Conversation tree is
 * always readable. Other Conversations are readable when they are public or
 * at the same Destination as the current one.
 */
import {
  canAccessConversation,
  readConversationAccessFromSql,
} from "@/api/conversations/access";
import type { ConversationEvent } from "@/chat/conversations/history";
import { getConversationStore, getDb } from "@/chat/db";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/**
 * Throw a repairable tool error unless the active context may read the event
 * log of `conversationId`. "Not found" and "no access" get the same error, so
 * the error does not show that a private Conversation exists.
 */
export async function assertCanReadConversationEvents(
  context: ToolRuntimeContext,
  conversationId: string,
): Promise<void> {
  const notAccessible = new ToolInputError(
    `Conversation events are not accessible: ${conversationId}`,
  );
  const [access, target] = await Promise.all([
    readConversationAccessFromSql(getDb(), [
      context.conversationId,
      conversationId,
    ]),
    getConversationStore().get({ conversationId }),
  ]);
  const targetAccess = access.get(conversationId);
  if (
    !target ||
    !targetAccess ||
    !canAccessConversation({
      // A requester that is not stored yet reaches only public targets.
      requester: access.get(context.conversationId) ?? { visibility: null },
      target: targetAccess,
    })
  ) {
    throw notAccessible;
  }
  if (target.transcriptPurgedAtMs !== undefined) {
    throw new ToolInputError(
      `Conversation transcript was purged: ${conversationId}`,
    );
  }
}

/** Replace replacement history with its item count; the original events stay readable by seq. */
export function stripReplacementHistory(
  data: ConversationEvent["data"],
): ConversationEvent["data"] | Record<string, unknown> {
  if (data.type === "unknown") {
    return {
      ...data,
      payload: stripReplacementHistoryField(data.payload),
    };
  }
  if (data.type === "compaction" || data.type === "handoff") {
    return stripReplacementHistoryField(data) as Record<string, unknown>;
  }
  return data;
}

function stripReplacementHistoryField(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { replacementHistory, ...rest } = value as Record<string, unknown>;
  if (replacementHistory === undefined) {
    return value;
  }
  return {
    ...rest,
    replacement_history_count: Array.isArray(replacementHistory)
      ? replacementHistory.length
      : 0,
  };
}
