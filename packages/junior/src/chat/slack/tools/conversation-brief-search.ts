import type { ConversationBriefSearchPort } from "@/chat/tools/search-conversation-briefs";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { SlackTeamId } from "@/chat/slack/ids";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";

/** Create Slack-owned filtering and match details for Brief search. */
export function createSlackConversationBriefSearchPort(
  teamId: SlackTeamId,
): ConversationBriefSearchPort {
  return {
    channelFilterSchema: slackChannelRefParam,
    async resolveChannel(input) {
      const target = await resolveSlackChannelRef({
        field: "channel_id",
        value: input,
        teamId,
      });
      return target.channelId;
    },
    async describeMatch(match) {
      const reference = parseSlackThreadId(match.conversationId);
      if (!reference || reference.channelId !== match.providerDestinationId) {
        return {};
      }
      const permalink = await getSlackMessagePermalink({
        channelId: reference.channelId,
        messageTs: reference.threadTs,
      });
      return {
        channel_id: reference.channelId,
        ...(match.channelName
          ? { channel_name: match.channelName }
          : undefined),
        ...(permalink ? { permalink } : undefined),
      };
    },
  };
}
