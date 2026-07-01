import type { Destination } from "@sentry/junior-plugin-api";
import type { Conversation } from "@/chat/conversations/store";
import { normalizeSlackConversationId } from "@/chat/slack/client";
import { checkSlackChannelReadAccess } from "@/chat/tools/slack/channel-access";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export interface TranscriptAccess {
  conversation: Conversation;
  destination: Record<string, unknown>;
  slackChannelId?: string;
}

type SlackRuntimeToolContext = Extract<
  ToolRuntimeContext,
  { source: { platform: "slack" } }
>;
type LocalRuntimeToolContext = Extract<
  ToolRuntimeContext,
  { source: { platform: "local" } }
>;

function destinationSummary(destination: Destination): Record<string, unknown> {
  if (destination.platform === "slack") {
    return {
      platform: "slack",
      team_id: destination.teamId,
      channel_id: destination.channelId,
    };
  }
  return {
    platform: "local",
    conversation_id: destination.conversationId,
  };
}

function slackConversationAccess(
  conversation: Conversation,
  context: SlackRuntimeToolContext,
): TranscriptAccess | undefined {
  const destination = conversation.destination;
  if (
    destination?.platform !== "slack" ||
    destination.teamId !== context.source.teamId
  ) {
    return undefined;
  }
  const channelId = normalizeSlackConversationId(destination.channelId);
  if (!channelId) {
    return undefined;
  }
  const access = checkSlackChannelReadAccess({
    targetChannelId: channelId,
    currentChannelIds: [
      context.source.channelId,
      context.destination.teamId === context.source.teamId
        ? context.destination.channelId
        : undefined,
    ],
  });
  if (!access.allowed) {
    return undefined;
  }
  return {
    conversation,
    destination: destinationSummary(destination),
    slackChannelId: channelId,
  };
}

function localConversationAccess(
  conversation: Conversation,
  context: LocalRuntimeToolContext,
): TranscriptAccess | undefined {
  const destination = conversation.destination;
  if (destination?.platform !== "local") {
    return undefined;
  }
  if (destination.conversationId !== context.source.conversationId) {
    return undefined;
  }
  return {
    conversation,
    destination: destinationSummary(destination),
  };
}

function isSlackRuntimeToolContext(
  context: ToolRuntimeContext,
): context is SlackRuntimeToolContext {
  return context.source.platform === "slack";
}

/**
 * Resolve transcript visibility from the active runtime context.
 *
 * Slack access is limited to the same workspace plus public-channel or current
 * source/destination private/DM channel rules. Local access requires the exact
 * current local conversation. Callers must pass this gate before loading thread
 * state.
 */
export function transcriptAccess(
  conversation: Conversation,
  context: ToolRuntimeContext,
): TranscriptAccess | undefined {
  if (isSlackRuntimeToolContext(context)) {
    return slackConversationAccess(conversation, context);
  }
  return localConversationAccess(conversation, context);
}
