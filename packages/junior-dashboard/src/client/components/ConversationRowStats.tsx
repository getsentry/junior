import {
  formatCostTotal,
  formatRuntime,
  formatUsageTotal,
  slackLocationLabel,
} from "../format";
import type { Conversation } from "../types";

/** Render compact conversation details aligned to row context. */
export function ConversationRowStats(props: {
  conversation: Conversation;
  timeLabel: string;
}) {
  const tokens = formatUsageTotal(props.conversation.cumulativeUsage);
  const cost = formatCostTotal(props.conversation.cumulativeUsage);
  const runtime = formatRuntime(props.conversation.cumulativeDurationMs);
  const primaryStats = [
    tokens,
    cost,
    runtime ? `${runtime} runtime` : "",
  ].filter(Boolean);
  const secondaryStats = [
    props.timeLabel,
    slackLocationLabel(props.conversation, { includeId: false }),
  ].filter(Boolean);

  return (
    <div className="grid min-w-0 justify-items-end gap-1 text-right max-md:justify-items-start max-md:text-left">
      {primaryStats.length > 0 ? (
        <div className="text-[0.84rem] leading-relaxed text-[#b8b8b8]">
          {primaryStats.join(" · ")}
        </div>
      ) : null}
      {secondaryStats.length > 0 ? (
        <div className="max-w-full break-words text-[0.84rem] leading-relaxed text-[#888] md:truncate">
          {secondaryStats.join(" · ")}
        </div>
      ) : null}
    </div>
  );
}
