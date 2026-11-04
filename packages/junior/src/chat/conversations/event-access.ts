/**
 * Read access to a Conversation's durable event log for model-facing tools.
 * The current Conversation tree is always readable. Other Conversations
 * follow `policies/conversation-access.md`.
 */
import {
  canAccessConversation,
  readConversationAccessFromSql,
} from "@/api/conversations/access";
import type { ConversationEvent } from "@/chat/conversations/history";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore, getDb } from "@/chat/db";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/**
 * Throw a repairable tool error unless the active context may read the event
 * log of `conversationId`.
 */
export async function assertCanReadConversationEvents(
  context: ToolRuntimeContext,
  conversationId: string,
): Promise<void> {
  // "Not found" and "no access" get one error, so it does not show that a
  // private Conversation exists.
  const notAccessible = new ToolInputError(
    `Conversation events are not accessible: ${conversationId}`,
  );
  const conversationStore = getConversationStore();
  const target = await conversationStore.get({ conversationId });
  if (
    !target ||
    !(await canReadTarget(context, conversationStore, {
      conversationId,
      parentConversationId: target.parentConversationId,
    }))
  ) {
    throw notAccessible;
  }
  if (target.transcriptPurgedAtMs !== undefined) {
    throw new ToolInputError(
      `Conversation transcript was purged: ${conversationId}`,
    );
  }
}

async function canReadTarget(
  context: ToolRuntimeContext,
  conversationStore: ConversationStore,
  target: { conversationId: string; parentConversationId?: string },
): Promise<boolean> {
  const { conversationId } = target;
  const current = await conversationStore.get({
    conversationId: context.conversationId,
  });
  const [currentRootConversationId, targetRootConversationId] =
    await Promise.all([
      current
        ? resolveRootConversationId(
            conversationStore,
            context.conversationId,
            current.parentConversationId,
          )
        : context.conversationId,
      resolveRootConversationId(
        conversationStore,
        conversationId,
        target.parentConversationId,
      ),
    ]);
  if (
    conversationId === context.conversationId ||
    targetRootConversationId === currentRootConversationId
  ) {
    return true;
  }

  const viewer = context.actor
    ? (await readActorIdentity(context.actor))?.user
    : undefined;
  const access = await readConversationAccessFromSql(
    getDb(),
    [context.conversationId, conversationId],
    viewer,
  );
  const requester = access.get(context.conversationId);
  const targetAccess = access.get(conversationId);
  return Boolean(
    requester &&
    targetAccess &&
    canAccessConversation({ requester, target: targetAccess }),
  );
}

async function resolveRootConversationId(
  conversationStore: ConversationStore,
  conversationId: string,
  parentConversationId: string | undefined,
): Promise<string> {
  if (!parentConversationId) {
    return conversationId;
  }

  let cursor: string | undefined = parentConversationId;
  const seen = new Set<string>([conversationId]);
  while (cursor) {
    if (seen.has(cursor)) {
      // Fail closed on cycles; callers treat missing root as unauthorized.
      return conversationId;
    }
    seen.add(cursor);
    const parent = await conversationStore.get({ conversationId: cursor });
    if (!parent) {
      return conversationId;
    }
    if (!parent.parentConversationId) {
      return parent.conversationId;
    }
    cursor = parent.parentConversationId;
  }
  return conversationId;
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
