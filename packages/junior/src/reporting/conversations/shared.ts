import type { ConversationSummaryReport, ConversationSurface } from "./types";

/** Parse an ISO report timestamp without leaking invalid numbers downstream. */
export function reportTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

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

/** Select the most recently seen run independent of input ordering. */
export function newestRun(
  runs: ConversationSummaryReport[],
): ConversationSummaryReport {
  return [...runs].sort(
    (left, right) =>
      (reportTime(right.lastSeenAt) ?? 0) -
        (reportTime(left.lastSeenAt) ?? 0) || right.id.localeCompare(left.id),
  )[0]!;
}
