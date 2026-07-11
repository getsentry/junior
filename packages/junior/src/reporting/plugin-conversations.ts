import type { PluginConversationSummary } from "@sentry/junior-plugin-api";
import { readConversationFeedFromSql } from "@/api/conversations/list.query";

/** Supply bounded SQL conversation metadata to plugin operational reports. */
export async function listRecentConversationSummaries(
  requestedLimit = 25,
): Promise<PluginConversationSummary[]> {
  const limit = Math.max(0, Math.min(100, Math.floor(requestedLimit)));
  const feed = await readConversationFeedFromSql(limit);
  return feed.conversations.map((report) => {
    return {
      conversationId: report.conversationId,
      displayTitle: report.displayTitle,
      lastActivityAt: report.lastSeenAt,
      lastUpdatedAt: report.lastProgressAt,
      status: report.status,
      ...(report.channelName ? { channelName: report.channelName } : {}),
      ...(report.channelNameRedacted ? { channelNameRedacted: true } : {}),
      source: report.surface,
    };
  });
}
