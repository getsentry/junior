import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { SlackDestination } from "@sentry/junior-plugin-api";
import type { SlackRequester } from "@/chat/requester";

export interface SlackToolContext {
  destination: SlackDestination;
  requester?: SlackRequester;
  channelId: string;
  deliveryChannelId: string;
  messageTs?: string;
  teamId: string;
  threadTs?: string;
}

/** Resolve Slack-specific tool context from the active destination/requester. */
export function getSlackToolContext(
  context: ToolRuntimeContext,
): SlackToolContext | undefined {
  if (context.destination.platform !== "slack") {
    return undefined;
  }
  return {
    destination: context.destination,
    requester:
      context.requester?.platform === "slack" ? context.requester : undefined,
    channelId: context.destination.channelId,
    deliveryChannelId:
      context.slack?.deliveryChannelId ?? context.destination.channelId,
    messageTs: context.slack?.messageTs,
    teamId: context.destination.teamId,
    threadTs: context.slack?.threadTs,
  };
}
