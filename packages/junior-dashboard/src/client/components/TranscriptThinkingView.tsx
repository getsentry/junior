import { formatMessageTimestamp, stringifyPartValue } from "../format";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
  TranscriptThoughtLabel,
} from "./TranscriptHeadingRow";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Render a thinking transcript event collapsed with a truncated preview until expanded or searched. */
export function TranscriptThinkingView(props: {
  timestamp?: number;
  value: unknown;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const rendered = stringifyPartValue(props.value);
  const expandedText = rendered || "{}";
  const meta = [
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);
  const metaText = meta.join(" · ");

  const summary = (
    <>
      <TranscriptThoughtLabel />
      <TranscriptHeadingRow
        left={
          <span className="block min-w-0 truncate italic text-[#9a9a9a]">
            {expandedText}
          </span>
        }
        right={
          metaText ? (
            <TranscriptHeadingMeta className="min-w-0 break-words text-[0.78rem] not-italic text-[#777] max-md:hidden">
              {metaText}
            </TranscriptHeadingMeta>
          ) : undefined
        }
        rightClassName="min-w-0 max-md:hidden"
      />
    </>
  );

  const content = (
    <>
      {metaText ? (
        <div className="hidden min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2 max-md:grid">
          <span aria-hidden="true" />
          <div className="min-w-0 break-words py-1 font-mono text-[0.78rem] not-italic leading-snug text-[#777]">
            {metaText}
          </div>
        </div>
      ) : null}
      <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2">
        <span aria-hidden="true" />
        <div className="min-w-0 whitespace-pre-wrap break-words py-1 italic text-[#9a9a9a]">
          <HighlightText text={expandedText} />
        </div>
      </div>
    </>
  );

  if (searchActive) {
    return (
      <div className="py-1.5 text-[0.84rem] leading-relaxed text-[#888]">
        <div className="grid list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2">
          {summary}
        </div>
        {content}
      </div>
    );
  }

  return (
    <details className="py-1.5 text-[0.84rem] leading-relaxed text-[#888]">
      <summary className="grid cursor-pointer list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 transition-colors hover:text-[#b8b8b8] [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {content}
    </details>
  );
}
