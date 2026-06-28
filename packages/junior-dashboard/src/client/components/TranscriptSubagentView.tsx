import { Bot } from "lucide-react";

import { formatMessageTimestamp, formatMs } from "../format";
import type { TranscriptViewSubagentPart } from "../types";
import { ToolFrame } from "./ToolFrame";
import { HighlightText } from "./transcriptSearch";

/** Render a child-agent lifecycle event inside the transcript stream. */
export function TranscriptSubagentView(props: {
  part: TranscriptViewSubagentPart;
  timestamp?: number;
}) {
  const label = `${props.part.subagentKind} subagent`;
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
    props.part.parentToolCallId
      ? `parent ${props.part.parentToolCallId}`
      : undefined,
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);

  return (
    <ToolFrame
      meta={meta}
      mobileSummaryMeta={status}
      raw
      signature={
        <>
          <Bot
            aria-hidden="true"
            className="mt-px shrink-0 text-cyan-300"
            size={14}
            strokeWidth={2.25}
          />
          <strong className="min-w-0 break-words font-bold text-cyan-100">
            <HighlightText text={label} />
          </strong>
        </>
      }
    />
  );
}

function statusLabel(part: TranscriptViewSubagentPart): string | undefined {
  if (part.outcome === "success") return "completed";
  if (part.outcome === "error") return "error";
  if (part.outcome === "aborted") return "aborted";
  return part.status === "running" ? "running" : part.status;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
