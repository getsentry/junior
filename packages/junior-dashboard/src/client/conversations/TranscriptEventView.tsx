import { ChevronRight } from "lucide-react";

import { renderMentionText } from "./transcriptMentions";
import { messageRawText } from "./transcriptRenderModel";
import { HighlightText } from "./transcriptSearch";
import { RedactedMarker } from "./TranscriptRedacted";
import type { TranscriptViewMessage } from "../types";
import { TranscriptSummary } from "./TranscriptSummary";

function EventTypeChip(props: { eventType: string }) {
  return (
    <span className="break-all rounded-md border border-dashboard-border px-1.5 py-0.5 font-mono text-2xs leading-none text-dashboard-text-muted">
      <HighlightText text={props.eventType} />
    </span>
  );
}

/** Heading for several Events that arrived in one message. */
function batchSummary(events: readonly { label?: string }[]): string {
  const labels = new Set(events.map((event) => event.label).filter(Boolean));
  const label = labels.size === 1 ? [...labels][0] : undefined;
  return `${events.length} events${label ? ` · ${label}` : ""}`;
}

/** Render an Event Message whose heading expands its full text. */
export function TranscriptEventView(props: { message: TranscriptViewMessage }) {
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  const events = props.message.events ?? [];
  const isBatch = events.length > 1;
  const summary = isBatch
    ? batchSummary(events)
    : (props.message.trustedSummary ?? props.message.eventType ?? "");
  const heading = (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words font-display text-sm font-semibold leading-6 text-dashboard-text">
          {renderMentionText(summary, "event-summary")}
        </span>
        {!isBatch && props.message.eventType ? (
          <EventTypeChip eventType={props.message.eventType} />
        ) : null}
      </span>
      {isBatch ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {events.map((event, index) => (
            <li
              key={index}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-dashboard-text-muted"
            >
              <span className="min-w-0 break-words">
                {renderMentionText(
                  event.trustedSummary ?? event.eventType,
                  `event-summary-${index}`,
                )}
              </span>
              <EventTypeChip eventType={event.eventType} />
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );

  return (
    <div className="min-w-0 py-1">
      {text ? (
        <details className="group/event min-w-0">
          <TranscriptSummary
            flush
            className="flex items-start gap-2 text-dashboard-text-muted"
          >
            {heading}
            <ChevronRight
              aria-hidden="true"
              className="mt-1.5 size-3 shrink-0 transition-transform group-open/event:rotate-90"
              strokeWidth={2.2}
            />
          </TranscriptSummary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dashboard-border bg-dashboard-surface-panel px-3 py-2 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            <HighlightText text={text} />
          </pre>
        </details>
      ) : (
        <>
          {heading}
          {redacted ? (
            <div className="mt-2">
              <RedactedMarker />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
