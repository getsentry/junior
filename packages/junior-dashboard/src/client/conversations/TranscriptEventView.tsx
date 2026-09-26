import { ChevronRight } from "lucide-react";

import { messageRawText } from "./transcriptRenderModel";
import { HighlightText } from "./transcriptSearch";
import { RedactedMarker } from "./TranscriptRedacted";
import type { TranscriptViewMessage } from "../types";

/** Render an Event Message whose heading expands its full text. */
export function TranscriptEventView(props: { message: TranscriptViewMessage }) {
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  const summary = props.message.trustedSummary ?? props.message.eventType ?? "";
  const heading = (
    <span className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 break-words font-display text-sm font-semibold leading-6 text-dashboard-text">
        <HighlightText text={summary} />
      </span>
      {props.message.eventType ? (
        <span className="break-all rounded-md border border-dashboard-border px-1.5 py-0.5 font-mono text-2xs leading-none text-dashboard-text-muted">
          <HighlightText text={props.message.eventType} />
        </span>
      ) : null}
    </span>
  );

  return (
    <div className="min-w-0 py-1">
      {text ? (
        <details className="group/event min-w-0">
          <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-dashboard-focus [&::-webkit-details-marker]:hidden">
            {heading}
            <ChevronRight
              aria-hidden="true"
              className="mt-1.5 size-3 shrink-0 transition-transform group-open/event:rotate-90"
              strokeWidth={2.2}
            />
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dashboard-border bg-dashboard-surface px-3 py-2 font-mono text-xs leading-relaxed text-dashboard-text-muted">
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
