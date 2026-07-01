import { getSlackClient, withSlackRetries } from "@/chat/slack/client";

/** Resolve a Slack message permalink without making callers depend on success. */
export async function getSlackMessagePermalinkBestEffort(args: {
  channelId: string;
  messageTs: string;
}): Promise<string | undefined> {
  try {
    const response = await withSlackRetries(
      () =>
        getSlackClient().chat.getPermalink({
          channel: args.channelId,
          message_ts: args.messageTs,
        }),
      3,
      {
        action: "chat.getPermalink",
        spanAttributes: {
          "app.slack.channel_id": args.channelId,
          "app.slack.message_ts": args.messageTs,
        },
      },
    );
    return response.permalink;
  } catch {
    return undefined;
  }
}
