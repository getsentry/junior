import type { ReactNode } from "react";
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
export function TranscriptToolView(props: {
  part: TranscriptViewToolCallPart;
  timestamp?: number;
  view?: "raw" | "rich";
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  const duration = formatElapsedDuration(
    props.timestamp,
    props.part.resultTimestamp,
  );
  const hasDetails =
    props.part.input !== undefined || props.part.output !== undefined;
  const responseSize = formatPayloadSize(props.part.output);
  const executionMeta = [duration, responseSize].filter(isString).join(" · ");
  const meta = [executionMeta, timestamp].filter(isString);
  const mobileSummary = executionMeta;
  const preview = toolCallPreview(props.part.name, props.part.input);
  const signature = (
    <ToolSignature
      name={props.part.name}
      preview={props.view === "raw" ? null : preview}
      status={props.part.status}
    />
  );
  const frame =
    props.view === "raw" && hasDetails ? (
      <ToolFrame
        meta={meta}
        mobileSummaryMeta={mobileSummary}
        raw
        signature={signature}
        status={props.part.status}
      >
        <ToolBody>
          <HighlightedCode
            code={stringifyPartValue({
              call: {
                id: props.part.id,
                input: props.part.input,
                name: props.part.name,
              },
              result:
                props.part.status === "running"
                  ? undefined
                  : {
                      outcome: props.part.status,
                      output: props.part.output,
                    },
            })}
            language="json"
          />
        </ToolBody>
      </ToolFrame>
    ) : (
      <ToolFrame
        expandable={hasDetails}
        meta={meta}
        mobileSummaryMeta={mobileSummary}
        signature={signature}
        status={props.part.status}
      >
        {props.part.input !== undefined ? (
          <ToolBody label="arguments">
            <HighlightedCode
              code={stringifyPartValue(props.part.input)}
              language="json"
            />
          </ToolBody>
        ) : null}
        {props.part.output !== undefined ? (
          <ToolBody label="result">
            <HighlightedCode
              code={stringifyPartValue(props.part.output)}
              language="json"
            />
          </ToolBody>
        ) : null}
      </ToolFrame>
    );

  return <div className="min-w-0">{frame}</div>;
}

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

function ToolBody(props: { children: ReactNode; label?: string }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden bg-black/20 px-2.5 py-2">
      {props.label ? (
        <div className="pb-1.5 font-mono text-2xs font-bold uppercase leading-none tracking-[0.08em] text-dashboard-text-muted">
          {props.label}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
