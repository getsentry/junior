import type { Target } from "@/chat/guardian/guardian";
import { getConversationInfo } from "@/chat/slack/channel";
import { parseSlackChannelId } from "@/chat/slack/ids";

/**
 * A Slack channel or DM as a Guardian target (`audience` in
 * `design/guardian.md`). It is `world` when Slack says another organization
 * shares it (Slack Connect), and when Slack cannot answer.
 */
export async function slackChannelTarget(channel: string): Promise<Target> {
  const unknown: Target = {
    ref: `Slack channel ${channel}`,
    audience: "world",
  };
  const channelId = parseSlackChannelId(channel);
  if (!channelId) return unknown;
  try {
    const info = await getConversationInfo(channelId);
    return {
      ref: info.name
        ? `Slack channel #${info.name}`
        : `Slack channel ${channelId}`,
      audience: info.isExtShared ? "world" : "internal",
    };
  } catch {
    return unknown;
  }
}
