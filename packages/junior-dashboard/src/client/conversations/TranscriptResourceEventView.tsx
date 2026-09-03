import { ChevronRight } from "lucide-react";

import { messageRawText } from "./transcriptRenderModel";
import { HighlightText } from "./transcriptSearch";
import { RedactedMarker } from "./TranscriptRedacted";
import type { TranscriptViewMessage } from "../types";

/** Render the trigger for a resource-event Turn without exposing its raw input. */
export function TranscriptResourceEventView(props: {
  message: TranscriptViewMessage;
}) {
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  const headline =
    props.message.trustedSummary ?? props.message.eventType ?? "";

  return (
    <div className="min-w-0 px-0.5 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-display text-sm font-semibold leading-snug text-dashboard-text">
          <HighlightText text={headline} />
        </span>
        {props.message.eventType ? (
          <span className="rounded-md border border-dashboard-border px-1.5 py-0.5 font-mono text-2xs leading-none text-dashboard-text-muted">
            <HighlightText text={props.message.eventType} />
          </span>
        ) : null}
      </div>
      {text ? (
        <details className="group/resource-event mt-1.5 min-w-0">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-3 transition-transform group-open/resource-event:rotate-90"
              strokeWidth={2.2}
            />
            <span className="group-open/resource-event:hidden">
              View raw event
            </span>
            <span className="hidden group-open/resource-event:inline">
              Hide raw event
            </span>
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dashboard-border bg-dashboard-surface px-3 py-2 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            <HighlightText text={text} />
          </pre>
        </details>
      ) : redacted ? (
        <div className="mt-2">
          <RedactedMarker />
        </div>
      ) : null}
    </div>
  );
}
