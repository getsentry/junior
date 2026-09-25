import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { SlackSource } from "@sentry/junior-plugin-api";
import type { SlackActor } from "@/chat/actor";
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
  actor?: SlackActor;
  destinationChannelId: SlackChannelId;
  locationChannelId: SlackChannelId;
  messageChannelId?: SlackChannelId;
  messageTs?: SlackMessageTs;
  teamId: SlackTeamId;
  threadTs?: SlackMessageTs;
}

/** Resolve Slack tool context from the Conversation Location. */
export function getSlackToolContext(
  context: ToolRuntimeContext,
): SlackToolContext | undefined {
  // TODO(dcramer): Remove the Slack Source fallback after every deployed
  // Conversation that came from Slack has a stored Location.
  const source: SlackSource | undefined =
    context.source.kind === "slack" ? context.source : undefined;
  const location =
    context.location?.provider === "slack"
      ? context.location
      : source
        ? {
            provider: "slack" as const,
            teamId: source.teamId,
            channelId: source.channelId,
            threadTs: source.threadTs,
          }
        : undefined;
  if (!location) return undefined;

  const destinationChannelId = parseSlackChannelReferenceId(
    context.destination.platform === "slack"
      ? context.destination.channelId
      : location.channelId,
  );
  const locationChannelId = parseSlackChannelReferenceId(location.channelId);
  const teamId = parseSlackTeamId(location.teamId);
  if (!destinationChannelId || !locationChannelId || !teamId) {
    return undefined;
  }

  return {
    actor: context.actor?.platform === "slack" ? context.actor : undefined,
    destinationChannelId,
    locationChannelId,
    messageChannelId: source
      ? parseSlackChannelReferenceId(source.channelId)
      : undefined,
    messageTs: parseSlackMessageTs(source?.messageTs),
    teamId,
    threadTs: parseSlackMessageTs(location.threadTs),
  };
}
