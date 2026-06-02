import {
  formatDurationTotal,
  formatUsageTotal,
  slackLocationLabel,
} from "../format";
import type { Conversation } from "../types";

/** Render compact conversation metadata aligned to row context. */
export function ConversationRowStats(props: {
  conversation: Conversation;
  timeLabel: string;
}) {
  const tokens = formatUsageTotal(
    props.conversation.turns.map((turn) => turn.cumulativeUsage),
  );
  const runtime = formatDurationTotal(
    props.conversation.turns.map((turn) => turn.cumulativeDurationMs),
  );
  const primaryStats = [
    tokens,
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
