import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import { completeText } from "@/chat/pi/client";
import {
  getThreadTitleSourceMessage,
  isHumanConversationMessage,
} from "@/chat/services/conversation-memory";
import {
  fallbackShortTitle,
  generateShortTitle,
} from "@/chat/services/short-title";
import type { ThreadConversationState } from "@/chat/state/conversation";

const inFlightTitles = new Map<string, Promise<string | undefined>>();

/** Test-only: clear in-flight title work between cases. */
export function resetConversationTitleStateForTests(): void {
  inFlightTitles.clear();
}

/**
 * Set-once conversation title from the earliest human message.
 *
 * One automatic generation path for every surface. Starts only from durable
 * transcript writes via `scheduleConversationTitle`. Returns a newly persisted
 * title, or undefined when the conversation is already titled or generation
 * does not apply.
 */
async function ensureConversationTitle(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  conversationStore?: Pick<ConversationStore, "get" | "recordActivity">;
  nowMs?: number;
}): Promise<string | undefined> {
  const pending = inFlightTitles.get(args.conversationId);
  if (pending) {
    return pending;
  }

  const work = ensureConversationTitleOnce(args).finally(() => {
    inFlightTitles.delete(args.conversationId);
  });
  inFlightTitles.set(args.conversationId, work);
  return work;
}

async function ensureConversationTitleOnce(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  conversationStore?: Pick<ConversationStore, "get" | "recordActivity">;
  nowMs?: number;
}): Promise<string | undefined> {
  if (!args.conversation.messages.some(isHumanConversationMessage)) {
    return undefined;
  }

  const store = args.conversationStore ?? getConversationStore();
  try {
    const stored = await store.get({ conversationId: args.conversationId });
    // Already titled: generation is done.
    if (stored?.title?.trim()) {
      return undefined;
    }
    // Child conversations are execution machinery, not listable threads.
    if (stored?.lineage) {
      return undefined;
    }

    const titleSourceMessage = getThreadTitleSourceMessage(args.conversation);
    const sourceText = titleSourceMessage?.text.trim() ?? "";
    if (!titleSourceMessage || !sourceText) {
      return undefined;
    }

    let title: string;
    try {
      const generated = await generateShortTitle({
        completeText,
        kind: "conversation",
        sourceText,
      });
      title = generated ?? fallbackShortTitle(sourceText, "Conversation");
    } catch (error) {
      logWarn("conversation.title.generation.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
      title = fallbackShortTitle(sourceText, "Conversation");
    }

    const normalized = title.trim();
    if (!normalized) {
      return undefined;
    }

    // Keep lastActivityAtMs on the source message time. Title generation latency
    // must not reorder conversations by recent activity.
    const activityAtMs = titleSourceMessage.createdAtMs;
    const nowMs = args.nowMs ?? Date.now();
    try {
      await store.recordActivity({
        activityAtMs,
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

/**
 * Fire-and-forget title work after durable human transcript writes.
 * This is the only entry that starts generation.
 */
export function scheduleConversationTitle(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
}): void {
  if (!args.conversationId) {
    return;
  }
  void ensureConversationTitle({
    conversation: args.conversation,
    conversationId: args.conversationId,
  }).catch((error) => {
    logException(error, "conversation.title.task.failed");
  });
}

/**
 * Join in-flight generation when present, otherwise read the stored title.
 * Does not start generation; providers use this only to project a title.
 */
export async function resolveConversationTitle(args: {
  conversationId: string;
  conversationStore?: Pick<ConversationStore, "get">;
}): Promise<string | undefined> {
  const pending = inFlightTitles.get(args.conversationId);
  if (pending) {
    const generated = await pending;
    if (generated?.trim()) {
      return generated.trim();
    }
  }

  const store = args.conversationStore ?? getConversationStore();
  const stored = await store.get({ conversationId: args.conversationId });
  return stored?.title?.trim() || undefined;
}
