import { botConfig } from "@/chat/config";
import { markTurnCompleted } from "@/chat/runtime/turn";
import {
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
  type SlackMessageBlock,
} from "@/chat/slack/footer";
import type { ThreadConversationState } from "@/chat/state/conversation";
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
