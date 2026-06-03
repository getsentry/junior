import {
  resolveSlackConversationContextFromThreadId,
  type SlackConversationContext,
} from "@/chat/slack/conversation-context";
import type { AgentTurnSessionRecord } from "@/chat/state/turn-session";

/**
 * Restore Slack facts for refreshing the volatile runtime prompt block on the
 * same in-progress turn, not for carrying context into later user turns.
 */
export function slackConversationContextForResume(
  sessionRecord: AgentTurnSessionRecord,
): SlackConversationContext | undefined {
  return (
    sessionRecord.slackConversation ??
    resolveSlackConversationContextFromThreadId({
      threadId: sessionRecord.conversationId,
      channelName: sessionRecord.channelName,
    })
  );
}
