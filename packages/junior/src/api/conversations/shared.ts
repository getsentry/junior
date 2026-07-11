import type { ConversationSummaryReport, ConversationSurface } from "./schema";

/** Format a Slack destination without exposing private channel names. */
export function slackStatsLocationLabel(
  input: Pick<
    ConversationSummaryReport,
    "channel" | "channelName" | "channelNameRedacted"
  >,
): string | undefined {
  const channelId = input.channel;
  if (!channelId) return undefined;

  if (input.channelNameRedacted && input.channelName) {
    return input.channelName;
  }

  const name = input.channelName?.replace(/^#/, "");
  if (channelId.startsWith("D")) return "Direct Message";
  if (channelId.startsWith("C")) return name ? `#${name}` : "Public Channel";
  if (channelId.startsWith("G")) {
    if (name?.startsWith("mpdm-")) return "Group DM";
    return "Private Channel";
  }
  return name || channelId;
}

/** Return the generic display label for a conversation surface. */
export function surfaceFallbackLabel(surface: ConversationSurface): string {
  if (surface === "scheduler") return "Scheduler";
  if (surface === "api") return "API";
  if (surface === "internal") return "Internal";
  return "Conversation";
}
