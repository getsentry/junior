import { formatMessageTimestamp } from "../format";
import type { TranscriptViewStructuredEventPart } from "../types";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

type TranscriptPresentationEventPart = TranscriptViewStructuredEventPart;

/** Render one structured event with core-owned transcript interaction. */
export function TranscriptStructuredEventView(props: {
  part: TranscriptPresentationEventPart;
  timestamp?: number;
}) {
  const search = useTranscriptSearch();
  const presentation = props.part.presentation;
  const timestamp = formatMessageTimestamp(props.timestamp);
  const details = presentation.details ?? [];
  const surfaceClass =
    "min-w-0 rounded-md bg-violet-300/[0.07] px-2.5 py-1.5 font-mono text-xs leading-tight";
  const body =
    details.length > 0 ? (
      <div className="grid gap-2 pb-1 pt-2">
        {details.map((detail, index) => (
          <div
            className="rounded bg-white/[0.04] px-3 py-2.5"
            key={`${detail.title}:${index}`}
          >
            <div className="whitespace-pre-wrap break-words text-sm text-dashboard-text">
              <HighlightText text={detail.title} />
            </div>
            {detail.description ? (
              <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-dashboard-text-muted">
                <HighlightText text={detail.description} />
              </div>
            ) : null}
            {detail.content ? (
              <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-3 font-mono text-xs leading-relaxed text-dashboard-text-muted">
                <HighlightText text={detail.content} />
              </pre>
            ) : null}
            {detail.metadata?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.metadata.map((value) => (
                  <span
                    className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-xs text-dashboard-text-muted"
                    key={value}
                  >
                    <HighlightText text={value} />
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    ) : null;
  const header = (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 max-md:grid-cols-[minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="font-display text-sm font-semibold text-violet-100">
          <HighlightText text={presentation.title} />
        </div>
        {presentation.preview ? (
          <div className="mt-0.5 truncate text-xs text-dashboard-text-muted">
            <HighlightText text={presentation.preview} />
          </div>
        ) : null}
      </div>
      {timestamp ? (
        <span className="font-mono text-xs text-dashboard-text-muted max-md:hidden">
          {timestamp}
        </span>
      ) : null}
    </div>
  );

  if (details.length === 0 || search.active) {
    return (
      <div className={surfaceClass}>
        {header}
        {body}
      </div>
    );
  }
  return (
    <details className={`group/plugin-event ${surfaceClass}`}>
      <summary className="cursor-pointer list-none transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden">
        {header}
      </summary>
      {body}
    </details>
  );
}
