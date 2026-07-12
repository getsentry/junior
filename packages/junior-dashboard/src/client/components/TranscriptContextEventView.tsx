import { ArrowRight, Minimize2, Send } from "lucide-react";

import { formatMessageTimestamp } from "../format";
import type { TranscriptViewContextEventPart } from "../types";
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
  const handoff = event.type === "model_handoff";
  const summary = event.summary;
  const { active: searchActive } = useTranscriptSearch();

  return (
    <article className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-3 border-y border-[#beaaff]/15 bg-[#beaaff]/[0.045] px-3 py-3 first:mt-1">
      <div
        aria-hidden="true"
        className="grid size-8 place-items-center rounded-md border border-[#beaaff]/25 bg-[#beaaff]/10 text-violet-200"
      >
        {handoff ? <Send size={15} /> : <Minimize2 size={15} />}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <strong className="text-[0.88rem] font-bold text-[#e8e3f8]">
            {handoff ? "Model handoff" : "Context compacted"}
          </strong>
          {typeof props.timestamp === "number" ? (
            <span className="text-[0.76rem] text-[#777]">
              {formatMessageTimestamp(props.timestamp)}
            </span>
          ) : null}
        </div>

        {handoff ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[0.8rem] text-[#888]">
            {event.fromModelId ? (
              <ModelLabel modelId={event.fromModelId} />
            ) : (
              <span>Previous model</span>
            )}
            <ArrowRight aria-hidden="true" size={13} />
            <ModelLabel modelId={event.toModelId} />
          </div>
        ) : event.modelId ? (
          <div className="mt-1.5 text-[0.8rem] text-[#888]">
            Continuing with <ModelLabel modelId={event.modelId} />
          </div>
        ) : (
          <div className="mt-1.5 text-[0.8rem] text-[#888]">
            Earlier context was summarized for the next turn.
          </div>
        )}

        {summary ? (
          <details
            className="mt-2 text-[0.82rem] leading-relaxed text-[#b8b8b8]"
            open={searchActive || undefined}
          >
            <summary className="w-fit cursor-pointer select-none text-[#aaa] hover:text-[#d6d6d6]">
              View summary
            </summary>
            <div className="mt-2 border-l-2 border-[#beaaff]/25 pl-3 text-[#c8c8c8]">
              <HighlightText text={summary} />
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}
