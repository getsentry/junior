import { ArrowRight } from "lucide-react";

import { formatMessageTimestamp } from "../format";
import type { TranscriptViewContextEventPart } from "../types";
import { TranscriptMarkdown } from "./TranscriptMarkdown";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

function modelLabel(modelId: string): string {
  return modelId.split("/").at(-1) ?? modelId;
}

function ModelLabel(props: { modelId: string }) {
  return (
    <code className="bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.76rem] text-[#d6d6d6]">
      {modelLabel(props.modelId)}
    </code>
  );
}

/** Render an inline context change without exposing storage epochs to operators. */
export function TranscriptContextEventView(props: {
  part: TranscriptViewContextEventPart;
  timestamp?: number;
}) {
  const event = props.part.event;
  if (event.type === "model_handoff") {
    return <ModelHandoffView event={event} timestamp={props.timestamp} />;
  }
  return <ContextCompactedView event={event} timestamp={props.timestamp} />;
}

function ModelHandoffView(props: {
  event: Extract<
    TranscriptViewContextEventPart["event"],
    { type: "model_handoff" }
  >;
  timestamp?: number;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const header = (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong className="font-display text-[0.88rem] font-semibold text-sky-100">
          Model handoff
        </strong>
        {typeof props.timestamp === "number" ? (
          <span className="text-[0.76rem] text-white/35">
            {formatMessageTimestamp(props.timestamp)}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[0.8rem] text-white/45">
        {props.event.fromModelId ? (
          <ModelLabel modelId={props.event.fromModelId} />
        ) : (
          <span>Previous model</span>
        )}
        <ArrowRight aria-hidden="true" size={13} />
        <ModelLabel modelId={props.event.toModelId} />
      </div>
    </div>
  );
  const className =
    "min-w-0 rounded-lg border border-sky-300/10 bg-sky-300/[0.035] first:mt-1";

  if (!props.event.message) {
    return <article className={`${className} px-3 py-3`}>{header}</article>;
  }

  return (
    <details className={className} open={searchActive || undefined}>
      <summary className="block cursor-pointer list-none px-3 py-3 transition-colors hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-300/55 [&::-webkit-details-marker]:hidden">
        {header}
      </summary>
      <pre className="min-w-0 whitespace-pre-wrap break-words border-t border-sky-300/10 px-3 py-3 font-mono text-[0.82rem] leading-relaxed text-white/65">
        <HighlightText text={props.event.message} />
      </pre>
    </details>
  );
}

function ContextCompactedView(props: {
  event: Extract<
    TranscriptViewContextEventPart["event"],
    { type: "context_compacted" }
  >;
  timestamp?: number;
}) {
  const { active: searchActive } = useTranscriptSearch();

  return (
    <article className="min-w-0 rounded-lg border border-amber-300/10 bg-amber-300/[0.035] px-3 py-3 first:mt-1">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <strong className="font-display text-[0.88rem] font-semibold text-amber-100">
            Context compacted
          </strong>
          {typeof props.timestamp === "number" ? (
            <span className="text-[0.76rem] text-white/35">
              {formatMessageTimestamp(props.timestamp)}
            </span>
          ) : null}
        </div>

        {props.event.modelId ? (
          <div className="mt-1.5 text-[0.8rem] text-white/45">
            Continuing with <ModelLabel modelId={props.event.modelId} />
          </div>
        ) : (
          <div className="mt-1.5 text-[0.8rem] text-white/45">
            Earlier context was summarized for the next turn.
          </div>
        )}

        {props.event.summary ? (
          <details
            className="mt-2 text-[0.82rem] leading-relaxed text-white/55"
            open={searchActive || undefined}
          >
            <summary className="w-fit cursor-pointer select-none text-amber-100/65 hover:text-amber-50">
              View summary
            </summary>
            <div className="mt-2 border-l border-white/10 pl-3 text-white/65">
              {searchActive ? (
                <HighlightText text={props.event.summary} />
              ) : (
                <TranscriptMarkdown text={props.event.summary} />
              )}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}
