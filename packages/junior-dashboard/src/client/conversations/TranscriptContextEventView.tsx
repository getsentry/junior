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
    <article className="min-w-0 px-0.5 py-1 first:mt-0.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong
          className={`font-display text-xs font-semibold ${
            handoff ? "text-sky-100" : "text-amber-100"
          }`}
        >
          {handoff ? "Model handoff" : "Context compacted"}
        </strong>
        {typeof props.timestamp === "number" ? (
          <span className="text-2xs text-dashboard-text-muted">
            {formatMessageTimestamp(props.timestamp)}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-dashboard-text-muted">
        {handoff
          ? `Execution continued with the ${event.modelProfile} profile (${event.modelId}${event.reasoningLevel ? `, ${event.reasoningLevel}` : ""}).`
          : `Earlier context was summarized${compactionDetail}${compactionModel} before execution continued.`}
      </div>
      {event.summary ? (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-2xs font-medium text-dashboard-text-muted">
            Continuation summary
          </summary>
          <div className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-dashboard-text-muted">
            <TranscriptText role="system" text={event.summary} />
          </div>
        </details>
      ) : null}
    </article>
  );
}
