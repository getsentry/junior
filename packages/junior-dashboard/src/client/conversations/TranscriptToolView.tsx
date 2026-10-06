import { memo, useMemo } from "react";
import { TriangleAlert } from "lucide-react";

import { HighlightedCode } from "../code";
import {
  formatElapsedDuration,
  formatMessageTimestamp,
  formatPayloadSize,
  stringifyPartValue,
} from "../format";
import type { TranscriptViewToolCallPart } from "../types";
import { ShimmerText } from "../components/ShimmerText";
import { cn } from "../styles";
import { ToolFrame } from "./ToolFrame";
import { toolCallPreview } from "./toolCallPreview";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

/** Render one tool invocation as it advances from running to a terminal result. */
export const TranscriptToolView = memo(function TranscriptToolView(props: {
  part: TranscriptViewToolCallPart;
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  const duration = formatElapsedDuration(
    props.timestamp,
    props.part.resultTimestamp,
  );
  const hasDetails =
    props.part.input !== undefined || props.part.output !== undefined;
  const responseSize = useMemo(
    () => formatPayloadSize(props.part.output),
    [props.part.output],
  );
  const executionMeta = [duration, responseSize].filter(isString).join(" · ");
  const meta = [executionMeta, timestamp].filter(isString);
  const mobileSummary = executionMeta;
  const preview = toolCallPreview(props.part.name, props.part.input);
  const signature = (
    <ToolSignature
      name={props.part.name}
      preview={preview}
      status={props.part.status}
    />
  );
  const frame = (
    <ToolFrame
      expandable={hasDetails}
      meta={meta}
      mobileSummaryMeta={mobileSummary}
      signature={signature}
    >
      {props.part.input !== undefined ? (
        <ToolPayload label="arguments" value={props.part.input} />
      ) : null}
      {props.part.output !== undefined ? (
        <ToolPayload label="result" value={props.part.output} />
      ) : null}
    </ToolFrame>
  );

  return <div className="min-w-0">{frame}</div>;
});

function ToolSignature(props: {
  name: string;
  preview: string | null;
  status: TranscriptViewToolCallPart["status"];
}) {
  const { active: searchActive } = useTranscriptSearch();
  const running = props.status === "running";
  const failed = props.status === "error";
  const shimmering = running && !searchActive;
  const statusLabel = running
    ? `${props.name} (running)`
    : failed
      ? `${props.name} (failed)`
      : undefined;

  return (
    <>
      {failed ? (
        <TriangleAlert
          aria-hidden="true"
          className="shrink-0 !text-rose-300"
          size={12}
          strokeWidth={2.2}
        />
      ) : null}
      <ShimmerText
        active={shimmering}
        aria-label={statusLabel}
        as="strong"
        className={cn(
          "shrink-0 font-bold",
          failed ? "!text-rose-300" : !shimmering && "text-dashboard-text",
        )}
      >
        <HighlightText text={props.name} />
      </ShimmerText>
      {props.preview && !searchActive ? (
        <code className="min-w-0 truncate font-[inherit] text-dashboard-text-muted group-open:hidden">
          (<HighlightText text={props.preview} />)
        </code>
      ) : null}
    </>
  );
}

function ToolPayload(props: { label: string; value: unknown }) {
  const code = useMemo(() => stringifyPartValue(props.value), [props.value]);
  return (
    <div className="min-w-0 max-w-full overflow-hidden bg-black/20 px-2.5 py-2">
      <div className="pb-1.5 font-mono text-2xs font-bold uppercase leading-none tracking-[0.08em] text-dashboard-text-muted">
        {props.label}
      </div>
      <HighlightedCode code={code} language="json" />
    </div>
  );
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
