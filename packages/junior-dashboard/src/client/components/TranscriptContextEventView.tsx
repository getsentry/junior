import { ArrowRight, Minimize2, Send } from "lucide-react";

import { formatMessageTimestamp } from "../format";
import type { TranscriptViewContextEventPart } from "../types";
import { TranscriptMarkdown } from "./TranscriptMarkdown";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

function modelLabel(modelId: string): string {
  return modelId.split("/").at(-1) ?? modelId;
}

function ModelLabel(props: { modelId: string }) {
  return (
    <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.76rem] text-[#d6d6d6]">
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
    <>
      <div
        aria-hidden="true"
        className="grid size-8 place-items-center rounded-md border border-[#beaaff]/25 bg-[#beaaff]/10 text-violet-200"
      >
        <Send size={15} />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <strong className="text-[0.88rem] font-bold text-[#e8e3f8]">
            Model handoff
          </strong>
          {typeof props.timestamp === "number" ? (
            <span className="text-[0.76rem] text-[#777]">
              {formatMessageTimestamp(props.timestamp)}
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[0.8rem] text-[#888]">
          {props.event.fromModelId ? (
            <ModelLabel modelId={props.event.fromModelId} />
          ) : (
            <span>Previous model</span>
          )}
          <ArrowRight aria-hidden="true" size={13} />
          <ModelLabel modelId={props.event.toModelId} />
        </div>
      </div>
    </>
  );
  const className =
    "min-w-0 border-y border-[#beaaff]/15 bg-[#beaaff]/[0.045] first:mt-1";

  if (!props.event.message) {
    return (
      <article
        className={`${className} grid grid-cols-[2rem_minmax(0,1fr)] gap-3 px-3 py-3`}
      >
        {header}
      </article>
    );
  }

  return (
    <details className={className} open={searchActive || undefined}>
      <summary className="grid cursor-pointer list-none grid-cols-[2rem_minmax(0,1fr)] gap-3 px-3 py-3 transition-colors hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#beaaff]/55 [&::-webkit-details-marker]:hidden">
        {header}
      </summary>
      <pre className="min-w-0 whitespace-pre-wrap break-words border-t border-[#beaaff]/15 px-3 py-3 font-mono text-[0.82rem] leading-relaxed text-[#c8c8c8]">
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
    <article className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-3 border-y border-[#beaaff]/15 bg-[#beaaff]/[0.045] px-3 py-3 first:mt-1">
      <div
        aria-hidden="true"
        className="grid size-8 place-items-center rounded-md border border-[#beaaff]/25 bg-[#beaaff]/10 text-violet-200"
      >
        <Minimize2 size={15} />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <strong className="text-[0.88rem] font-bold text-[#e8e3f8]">
            Context compacted
          </strong>
          {typeof props.timestamp === "number" ? (
            <span className="text-[0.76rem] text-[#777]">
              {formatMessageTimestamp(props.timestamp)}
            </span>
          ) : null}
        </div>

        {props.event.modelId ? (
          <div className="mt-1.5 text-[0.8rem] text-[#888]">
            Continuing with <ModelLabel modelId={props.event.modelId} />
          </div>
        ) : (
          <div className="mt-1.5 text-[0.8rem] text-[#888]">
            Earlier context was summarized for the next turn.
          </div>
        )}

        {props.event.summary ? (
          <details
            className="mt-2 text-[0.82rem] leading-relaxed text-[#b8b8b8]"
            open={searchActive || undefined}
          >
            <summary className="w-fit cursor-pointer select-none text-[#aaa] hover:text-[#d6d6d6]">
              View summary
            </summary>
            <div className="mt-2 border-l-2 border-[#beaaff]/25 pl-3 text-[#c8c8c8]">
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
