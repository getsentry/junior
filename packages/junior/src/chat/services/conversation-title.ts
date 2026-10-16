import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import { completeText } from "@/chat/pi/client";
import { getThreadTitleSourceMessage } from "@/chat/services/conversation-memory";
import {
  fallbackShortTitle,
  generateShortTitle,
} from "@/chat/services/short-title";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";

const inFlightTitles = new Map<string, Promise<string | undefined>>();

/** Test-only: clear in-flight title work between cases. */
export function resetConversationTitleStateForTests(): void {
  inFlightTitles.clear();
}

/**
 * Set-once conversation title from the earliest human message.
 *
 * One automatic generation path for every surface. Starts only from durable
 * transcript writes via `scheduleConversationTitle`. A dispatched run, such as
 * an automation run, has no human message, so its title comes from the run
 * input. A generated title replaces a provisional title once. Returns a newly
 * persisted title, or undefined when the conversation already has a final
 * title or generation does not apply.
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

/** Return the earliest user message, which is the input of a dispatched run. */
function getRunInputMessage(
  conversation: ThreadConversationState,
): ConversationMessage | undefined {
  let earliest: ConversationMessage | undefined;
  for (const message of conversation.messages) {
    if (
      message.role === "user" &&
      (!earliest || message.createdAtMs < earliest.createdAtMs)
    ) {
      earliest = message;
    }
  }
  return earliest;
}

async function ensureConversationTitleOnce(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  conversationStore?: Pick<ConversationStore, "get" | "recordActivity">;
  nowMs?: number;
}): Promise<string | undefined> {
  const humanMessage = getThreadTitleSourceMessage(args.conversation);
  const runInputMessage = humanMessage
    ? undefined
    : getRunInputMessage(args.conversation);
  if (!humanMessage && !runInputMessage) {
    return undefined;
  }

  const store = args.conversationStore ?? getConversationStore();
  try {
    const stored = await store.get({ conversationId: args.conversationId });
    // A final title ends generation. A provisional title waits for it.
    if (stored?.title?.trim() && !stored.titleProvisional) {
      return undefined;
    }
    // Conversations with a parent are execution machinery, not listable threads.
    if (stored?.parentConversationId) {
      return undefined;
    }
    // Only dispatched runs use bot-authored input as the title source.
    const titleSourceMessage =
      humanMessage ??
      (stored?.source === "plugin" ? runInputMessage : undefined);
    const sourceText = titleSourceMessage?.text.trim() ?? "";
    if (!titleSourceMessage || !sourceText) {
      return undefined;
    }

    const kind = humanMessage ? "conversation" : "run";
    let title: string | undefined;
    try {
      title = await generateShortTitle({ completeText, kind, sourceText });
    } catch (error) {
      logWarn("conversation.title.generation.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
    // Run input starts with task boilerplate, so a run keeps its provisional
    // title, or the dashboard fallback, when generation fails.
    if (!title && kind === "conversation") {
      title = fallbackShortTitle(sourceText, "Conversation");
    }
    const normalized = title?.trim();
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
 * Start title work after durable transcript writes. This is the only
 * entry that starts generation; `settleConversationTitleWork` joins it.
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
 * Wait for title generation started for one Conversation. The queue worker
 * gives this to `waitUntil` so title work has an owner.
 */
export async function settleConversationTitleWork(
  conversationId: string,
): Promise<void> {
  await inFlightTitles.get(conversationId);
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
