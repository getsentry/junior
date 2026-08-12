import { formatCompactNumber, formatMessageTimestamp } from "../format";
import type { TranscriptViewContextEventPart } from "../types";
import { TranscriptText } from "./TranscriptText";

/** Render a structural context change from the privacy-safe event API. */
export function TranscriptContextEventView(props: {
  part: TranscriptViewContextEventPart;
  timestamp?: number;
}) {
  const event = props.part.event;
  const handoff = event.type === "handoff";
  const compactionDetail =
    event.type === "compaction" && event.details
      ? ` at approximately ${formatCompactNumber(event.details.estimatedInputTokens)} estimated tokens`
      : "";
  const compactionModel =
    event.type === "compaction" && event.modelProfile && event.modelId
      ? ` using the ${event.modelProfile} profile (${event.modelId})`
      : "";
  return (
    <article
      className={`min-w-0 rounded-lg border px-3 py-3 first:mt-1 ${
        handoff
          ? "border-sky-300/10 bg-sky-300/[0.035]"
          : "border-amber-300/10 bg-amber-300/[0.035]"
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong
          className={`font-display text-sm font-semibold ${
            handoff ? "text-sky-100" : "text-amber-100"
          }`}
        >
          {handoff ? "Model handoff" : "Context compacted"}
        </strong>
        {typeof props.timestamp === "number" ? (
          <span className="text-xs text-dashboard-text-muted">
            {formatMessageTimestamp(props.timestamp)}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 text-sm text-dashboard-text-muted">
        {handoff
          ? `Execution continued with the ${event.modelProfile} profile (${event.modelId}${event.reasoningLevel ? `, ${event.reasoningLevel}` : ""}).`
          : `Earlier context was summarized${compactionDetail}${compactionModel} before execution continued.`}
      </div>
      {event.summary ? (
        <details className="mt-2 border-t border-dashboard-border-subtle pt-2">
          <summary className="cursor-pointer select-none text-xs font-medium text-dashboard-text-muted">
            Continuation summary
          </summary>
          <div className="mt-2 text-sm leading-relaxed text-dashboard-text-muted">
            <TranscriptText role="system" text={event.summary} />
          </div>
        </details>
      ) : null}
    </article>
  );
}
