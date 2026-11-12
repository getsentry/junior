import type { ConversationSearchChannelPort } from "@/chat/tools/search-conversations";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { SlackTeamId } from "@/chat/slack/ids";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";

/** Create Slack-owned channel filtering and match details for Conversation search. */
export function createSlackConversationSearchChannelPort(
  teamId: SlackTeamId,
): ConversationSearchChannelPort {
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
