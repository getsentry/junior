import { botConfig } from "@/chat/config";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { isRetryableTurnError, markTurnCompleted } from "@/chat/runtime/turn";
import {
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { buildAuthPauseReplyText } from "@/chat/services/pending-auth";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
  type SlackMessageBlock,
} from "@/chat/slack/footer";
import { postSlackMessage } from "@/chat/slack/outbound";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import { getTurnUserMessageId } from "@/chat/runtime/turn-user-message";
import type { AgentTurnUsage } from "@/chat/usage";

/** Build the Slack text + footer blocks for an auth-pause reply. */
export function buildAuthPauseSlackMessage(args: {
  conversationId?: string;
  durationMs?: number;
  text: string;
  thinkingLevel?: TurnThinkingSelection["thinkingLevel"];
  usage?: AgentTurnUsage;
}): { blocks?: SlackMessageBlock[]; text: string } {
  const footer = buildSlackReplyFooter({
    conversationId: args.conversationId,
    durationMs: args.durationMs,
    thinkingLevel: args.thinkingLevel,
    usage: args.usage,
  });
  const blocks = buildSlackReplyBlocks(args.text, footer);
  return blocks ? { text: args.text, blocks } : { text: args.text };
}

/** Persist a visible auth-pause note as the completed reply for the turn. */
export function completeAuthPauseTurn(args: {
  conversation: ThreadConversationState;
  sessionId: string;
  text: string;
}): void {
  markConversationMessage(
    args.conversation,
    getTurnUserMessageId(args.conversation, args.sessionId),
    {
      replied: true,
      skippedReason: undefined,
    },
  );
  upsertConversationMessage(args.conversation, {
    id: generateConversationId("assistant"),
    role: "assistant",
    text: normalizeConversationText(args.text) || "[empty response]",
    createdAtMs: Date.now(),
    author: {
      userName: botConfig.userName,
      isBot: true,
    },
    meta: {
      replied: true,
    },
  });
  markTurnCompleted({
    conversation: args.conversation,
    nowMs: Date.now(),
    updateConversationStats,
  });
}

/** Reload thread state, mark the auth-pause note as the turn's reply, and persist. */
export async function persistAuthPauseReplyState(args: {
  sessionId: string;
  text: string;
  threadStateId: string;
}): Promise<void> {
  const currentState = await getPersistedThreadState(args.threadStateId);
  const conversation = coerceThreadConversationState(currentState);
  completeAuthPauseTurn({
    conversation,
    sessionId: args.sessionId,
    text: args.text,
  });
  await persistThreadStateById(args.threadStateId, { conversation });
}

/**
 * Deliver the visible "I sent you a private link" reply for an auth-pause
 * resume and mark the turn as completed in persisted state.
 *
 * Used by every resume/callback path that surfaces an `onAuthPause` error.
 * Text and footer metadata come from the retryable error when available;
 * `fallbackProvider` only applies when a non-retryable error is surfaced.
 */
export async function deliverAuthPauseReply(args: {
  channelId: string;
  conversationId?: string;
  error: unknown;
  fallbackProvider?: string;
  sessionId: string;
  threadStateId: string;
  threadTs: string;
}): Promise<void> {
  const retryable = isRetryableTurnError(args.error) ? args.error : undefined;
  const text = retryable
    ? buildAuthPauseReplyText({
        disposition: retryable.metadata?.authDisposition,
        provider: retryable.metadata?.authProvider,
      })
    : buildAuthPauseReplyText({ provider: args.fallbackProvider });
  const message = buildAuthPauseSlackMessage({
    conversationId: args.conversationId,
    durationMs: retryable?.metadata?.authDurationMs,
    text,
    thinkingLevel: retryable?.metadata?.authThinkingLevel,
    usage: retryable?.metadata?.authUsage,
  });
  await postSlackMessage({
    channelId: args.channelId,
    threadTs: args.threadTs,
    text: message.text,
    ...(message.blocks ? { blocks: message.blocks } : {}),
  });
  await persistAuthPauseReplyState({
    sessionId: args.sessionId,
    text,
    threadStateId: args.threadStateId,
  });
}
