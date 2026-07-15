import { formatMessageTimestamp } from "../format";
import type { TranscriptViewToolCallPart } from "../types";
import { ToolFrame } from "./ToolFrame";
import { HighlightText } from "./transcriptSearch";

/** Render the structural start of one tool execution. */
export function TranscriptToolView(props: {
  part: TranscriptViewToolCallPart;
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  return (
    <ToolFrame
      meta={["started", timestamp].filter(isString)}
      mobileSummaryMeta="started"
      raw
      signature={
        <strong className="min-w-0 break-words font-bold text-[#d6d6d6]">
          <HighlightText text={props.part.name} />
        </strong>
      }
    />
  );
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
