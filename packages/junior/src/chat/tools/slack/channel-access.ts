import { normalizeSlackConversationId } from "@/chat/slack/client";

type SlackChannelAccessResult =
  | { allowed: true }
  | { allowed: false; error: string };

function normalizedChannelSet(
  channelIds: Array<string | undefined>,
): Set<string> {
  return new Set(
    channelIds
      .map((channelId) => normalizeSlackConversationId(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
}

/**
 * Check read access from local Slack ID conventions.
 *
 * Public `C` channels are readable within the workspace. Private `G` channels
 * and DMs require an exact current-context channel match.
 */
export function checkSlackChannelReadAccess(args: {
  currentChannelIds: Array<string | undefined>;
  targetChannelId: string;
}): SlackChannelAccessResult {
  const target = normalizeSlackConversationId(args.targetChannelId);
  if (!target) {
    return { allowed: false, error: "Invalid Slack channel ID." };
  }

  if (target.startsWith("C")) {
    return { allowed: true };
  }

  if (normalizedChannelSet(args.currentChannelIds).has(target)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error:
      "Cannot read private channels or DMs unless the target is from the current Slack context.",
  };
}
