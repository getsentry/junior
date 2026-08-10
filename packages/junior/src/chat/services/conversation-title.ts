import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import {
  getThreadTitleSourceMessage,
  type ConversationMemoryService,
} from "@/chat/services/conversation-memory";
import type { ThreadConversationState } from "@/chat/state/conversation";

/**
 * Generate and persist a conversation title once from the earliest human
 * message. Provider surfaces may project the stored title afterward.
 */
export async function ensureConversationTitle(args: {
  activityAtMs?: number;
  conversation: ThreadConversationState;
  conversationId: string;
  conversationStore?: Pick<ConversationStore, "get" | "recordActivity">;
  generateThreadTitle: ConversationMemoryService["generateThreadTitle"];
  nowMs?: number;
}): Promise<string | undefined> {
  const store = args.conversationStore ?? getConversationStore();
  try {
    const stored = await store.get({ conversationId: args.conversationId });
    if (stored?.title) {
      return undefined;
    }
    // Child conversations are execution machinery, not listable threads.
    if (stored?.lineage) {
      return undefined;
    }

    const titleSourceMessage = getThreadTitleSourceMessage(args.conversation);
    if (!titleSourceMessage?.text.trim()) {
      return undefined;
    }

    let title: string;
    try {
      title = await args.generateThreadTitle(titleSourceMessage.text);
    } catch (error) {
      logWarn("conversation.title.generation.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    const normalized = title.trim();
    if (!normalized) {
      return undefined;
    }

    const nowMs = args.nowMs ?? Date.now();
    try {
      await store.recordActivity({
        activityAtMs: args.activityAtMs ?? nowMs,
        conversationId: args.conversationId,
        nowMs,
        title: normalized,
      });
    } catch (error) {
      logException(error, "conversation.title.persist.failed");
      return undefined;
    }

    return normalized;
  } catch (error) {
    logException(error, "conversation.title.ensure.failed");
    return undefined;
  }
}
