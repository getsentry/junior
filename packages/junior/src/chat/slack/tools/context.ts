import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { SlackDestination } from "@sentry/junior-plugin-api";
import type { SlackSource } from "@sentry/junior-plugin-api";
import type { SlackRequester } from "@/chat/requester";
import {
  parseSlackChannelReferenceId,
  parseSlackTeamId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

export interface SlackToolContext {
  destination: SlackDestination;
  source: SlackSource;
  requester?: SlackRequester;
  destinationChannelId: SlackChannelId;
  messageTs?: SlackMessageTs;
  sourceChannelId: SlackChannelId;
  teamId: SlackTeamId;
  threadTs?: SlackMessageTs;
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
  const destinationChannelId = parseSlackChannelReferenceId(
    context.destination.channelId,
  );
  const sourceChannelId = parseSlackChannelReferenceId(
    context.source.channelId,
  );
  const teamId = parseSlackTeamId(context.source.teamId);
  if (!destinationChannelId || !sourceChannelId || !teamId) {
    return undefined;
  }

  return {
    destination: context.destination,
    source: context.source,
    requester:
      context.requester?.platform === "slack" ? context.requester : undefined,
    destinationChannelId,
    messageTs: parseSlackMessageTs(context.source.messageTs),
    sourceChannelId,
    teamId,
    threadTs: parseSlackMessageTs(context.source.threadTs),
  };
}
