import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { SlackDestination } from "@sentry/junior-plugin-api";
import type { SlackSource } from "@sentry/junior-plugin-api";
import type { SlackRequester } from "@/chat/requester";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

export interface SlackToolContext {
  destination: SlackDestination;
  source: SlackSource;
  requester?: SlackRequester;
  destinationChannelId: string;
  messageTs?: SlackMessageTs;
  sourceChannelId: string;
  teamId: string;
  threadTs?: string;
}

/** Resolve Slack-specific tool context from the active source/destination/requester. */
export function getSlackToolContext(
  context: ToolRuntimeContext,
): SlackToolContext | undefined {
  if (context.source.platform !== "slack") {
    return undefined;
  }
  if (context.destination.platform !== "slack") {
    throw new TypeError("Slack source requires a Slack destination");
  }
  return {
    destination: context.destination,
    source: context.source,
    requester:
      context.requester?.platform === "slack" ? context.requester : undefined,
    destinationChannelId: context.destination.channelId,
    messageTs: parseSlackMessageTs(context.source.messageTs),
    sourceChannelId: context.source.channelId,
    teamId: context.source.teamId,
    threadTs: context.source.threadTs,
  };
}
