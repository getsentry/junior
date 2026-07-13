import { formatMessageTimestamp, formatMs } from "../format";
import type { TranscriptViewSubagentPart } from "../types";
import { ToolFrame } from "./ToolFrame";
import { HighlightText } from "./transcriptSearch";

/** Render a child-agent lifecycle event inside the transcript stream. */
export function TranscriptSubagentView(props: {
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
  part: TranscriptViewSubagentPart;
  timestamp?: number;
}) {
  const label = props.part.subagentKind;
  const endedAt = props.part.endedAt
    ? Date.parse(props.part.endedAt)
    : undefined;
  const duration =
    typeof props.timestamp === "number" &&
    typeof endedAt === "number" &&
    Number.isFinite(endedAt) &&
    endedAt >= props.timestamp
      ? formatMs(endedAt - props.timestamp)
      : undefined;
  const status = statusLabel(props.part);
  const meta = [
    status,
    duration,
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);

  const frame = (
    <ToolFrame
      meta={meta}
      mobileSummaryMeta={status}
      raw
      signature={
        <>
          <strong className="min-w-0 break-words font-bold text-cyan-100">
            <HighlightText text={label} />
          </strong>
          {props.part.status === "running" ? (
            <span
              aria-hidden="true"
              className="mt-px size-1.5 shrink-0 animate-pulse rounded-full bg-cyan-300"
            />
          ) : null}
        </>
      }
    />
  );

  if (!props.onOpenTranscript || props.part.status === "running") {
    return frame;
  }

  return (
    <button
      aria-label={`Open ${props.part.subagentKind} transcript`}
      className="block w-full min-w-0 cursor-pointer text-left transition-colors hover:bg-white/[0.035] focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55"
      onClick={() => props.onOpenTranscript?.(props.part)}
      type="button"
    >
      {frame}
    </button>
  );
}

function statusLabel(part: TranscriptViewSubagentPart): string | undefined {
  if (part.outcome === "error") return "error";
  if (part.outcome === "aborted") return "aborted";
  if (part.status === "error" || part.status === "aborted") {
    return part.status;
  }
  return undefined;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
