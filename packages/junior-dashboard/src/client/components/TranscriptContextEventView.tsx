import { formatMessageTimestamp } from "../format";
import type { TranscriptViewContextEventPart } from "../types";

/** Render a structural context change from the privacy-safe event API. */
export function TranscriptContextEventView(props: {
  part: TranscriptViewContextEventPart;
  timestamp?: number;
}) {
  const event = props.part.event;
  const handoff = event.type === "handoff";
  return (
    <article
      className={`min-w-0 rounded-lg border px-3 py-3 first:mt-1 ${
        handoff
          ? "border-sky-300/10 bg-sky-300/[0.035]"
          : "border-amber-300/10 bg-amber-300/[0.035]"
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong
          className={`font-display text-[0.88rem] font-semibold ${
            handoff ? "text-sky-100" : "text-amber-100"
          }`}
        >
          {handoff ? "Model handoff" : "Context compacted"}
        </strong>
        {typeof props.timestamp === "number" ? (
          <span className="text-[0.76rem] text-white/35">
            {formatMessageTimestamp(props.timestamp)}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 text-[0.8rem] text-white/45">
        {handoff
          ? `Execution continued with the ${event.modelProfile} profile (${event.modelId}${event.reasoningLevel ? `, ${event.reasoningLevel}` : ""}).`
          : "Earlier context was summarized for the next turn."}
      </div>
    </article>
  );
}
