import { messageRawText } from "./transcriptRenderModel";
import { HighlightText } from "./transcriptSearch";
import { RedactedMarker } from "./TranscriptRedacted";
import type { TranscriptViewMessage } from "../types";

/** Render a plugin resource event as a collapsible transcript surface. */
export function TranscriptResourceEventView(props: {
  message: TranscriptViewMessage;
}) {
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  return (
    <details className="min-w-0 px-0.5 py-1">
      <summary className="cursor-pointer list-none font-display text-sm font-semibold text-dashboard-text transition-colors hover:text-violet-100 [&::-webkit-details-marker]:hidden">
        <HighlightText text={props.message.eventType ?? ""} />
      </summary>
      {text ? (
        <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text-muted">
          <HighlightText text={text} />
        </div>
      ) : redacted ? (
        <div className="mt-2">
          <RedactedMarker />
        </div>
      ) : null}
    </details>
  );
}
