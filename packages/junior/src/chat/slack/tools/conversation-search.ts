import type { ConversationSearchChannelPort } from "@/chat/tools/search-conversations";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { SlackTeamId } from "@/chat/slack/ids";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";

/** Slack channel filter of Conversation search. Its schema is part of the tool definition. */
export const slackConversationSearchChannelFilter = {
  channelFilterSchema: slackChannelRefParam,
};

/** Create Slack-owned channel filtering and match details for Conversation search. */
export function createSlackConversationSearchChannelPort(
  teamId: SlackTeamId,
): ConversationSearchChannelPort {
  return {
    ...slackConversationSearchChannelFilter,
    async resolveChannel(input) {
      const target = await resolveSlackChannelRef({
        field: "channel_id",
        value: input,
        teamId,
      });
      return target.channelId;
    },
    async describeMatch(match) {
      // A child agent has no Slack thread of its own. It belongs to its root.
      const reference = parseSlackThreadId(match.rootConversationId);
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
