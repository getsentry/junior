import { Lightbulb } from "lucide-react";

import { formatMessageTimestamp } from "../format";
import type { TranscriptViewReasoningPart } from "../types";
import { cn } from "../styles";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

/** Render reasoning collapsed with a short preview until expanded or searched. */
export function TranscriptReasoningView(props: {
  part: TranscriptViewReasoningPart;
  timestamp?: number;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const rendered = props.part.redacted ? "Reasoning redacted" : props.part.text;
  const timestamp = formatMessageTimestamp(props.timestamp);
  const summary = (
    <>
      <span
        aria-label="Reasoning"
        className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-violet-200/80"
        title="Reasoning"
      >
        <Lightbulb aria-hidden="true" size={13} strokeWidth={1.8} />
      </span>
      <TranscriptHeadingRow
        left={
          searchActive ? (
            <span className="block min-w-0 italic text-violet-100/75">
              Reasoning
            </span>
          ) : (
            <>
              <span className="block min-w-0 truncate italic text-violet-100/70 group-open/reasoning:hidden">
                {rendered}
              </span>
              <span className="hidden min-w-0 italic text-violet-100/75 group-open/reasoning:inline">
                Reasoning
              </span>
            </>
          )
        }
        right={
          timestamp ? (
            <TranscriptHeadingMeta className="min-w-0 break-words text-2xs not-italic text-dashboard-text-muted max-md:hidden">
              {timestamp}
            </TranscriptHeadingMeta>
          ) : undefined
        }
        rightClassName="min-w-0 max-md:hidden"
      />
    </>
  );
  const content = (
    <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2 bg-violet-950/15 px-2.5 pb-2 pt-1.5">
      <span aria-hidden="true" />
      <div className="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed italic text-violet-100/65">
        <HighlightText text={rendered} />
      </div>
    </div>
  );

  if (searchActive) {
    return (
      <div className={reasoningFrameClass()}>
        <div className="grid list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 px-2.5 py-1.5">
          {summary}
        </div>
        {content}
      </div>
    );
  }

  return (
    <details className={cn("group/reasoning", reasoningFrameClass())}>
      <summary className="grid cursor-pointer list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 px-2.5 py-1.5 transition-colors hover:bg-violet-300/[0.05] hover:text-violet-50 [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {content}
    </details>
  );
}

function reasoningFrameClass(): string {
  return "min-w-0 overflow-hidden rounded-md bg-violet-300/[0.075] text-sm leading-relaxed text-violet-100/70";
}
