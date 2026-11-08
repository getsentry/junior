/**
 * Read access to a Conversation's durable event log for model-facing tools,
 * under `policies/conversation-access.md`. The current Conversation tree is
 * always readable. Other Conversations are readable only when they are
 * public.
 */
import {
  canAccessConversation,
  type ConversationReach,
} from "@/api/conversations/access";
import type { ConversationEvent } from "@/chat/conversations/history";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore } from "@/chat/db";
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
  const conversationStore = getConversationStore();
  const target = await conversationStore.get({ conversationId });
  if (!target) {
    throw notAccessible;
  }

  const requester = await resolveRequesterReach(
    conversationStore,
    context.conversationId,
  );
  // A Conversation with a parent uses the root privacy boundary.
  const targetRootConversationId = await resolveRootConversationId(
    conversationStore,
    conversationId,
    target.parentConversationId,
  );
  const targetRoot =
    targetRootConversationId === conversationId
      ? target
      : await conversationStore.get({
          conversationId: targetRootConversationId,
        });
  if (
    !canAccessConversation({
      requester,
      target: {
        rootConversationId: targetRootConversationId,
        visibility: targetRoot?.visibility ?? target.visibility ?? null,
      },
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

async function resolveRequesterReach(
  conversationStore: ConversationStore,
  currentConversationId: string,
): Promise<ConversationReach> {
  const current = await conversationStore.get({
    conversationId: currentConversationId,
  });
  // Only the requester tree matters for read access, not its visibility.
  const rootConversationId = current
    ? await resolveRootConversationId(
        conversationStore,
        currentConversationId,
        current.parentConversationId,
      )
    : currentConversationId;
  return { rootConversationId, visibility: null };
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
