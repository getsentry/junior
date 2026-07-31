import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";

/** Build Slack's browser-safe redirect to a conversation when its IDs are valid. */
export function buildSlackSourceUrl(args: {
  channelId: string;
  teamId: string;
}): string | undefined {
  const channelId = parseSlackChannelId(args.channelId);
  const teamId = parseSlackTeamId(args.teamId);
  if (!channelId || !teamId) return undefined;

  const url = new URL("https://slack.com/app_redirect");
  url.searchParams.set("channel", channelId);
  url.searchParams.set("team", teamId);
  return url.toString();
}
