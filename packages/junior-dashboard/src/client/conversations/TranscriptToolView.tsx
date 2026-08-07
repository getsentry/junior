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
      running={props.part.status === "running"}
    />
  );
  const frame =
    props.view === "raw" && hasDetails ? (
      <ToolFrame
        meta={meta}
        mobileSummaryMeta={mobileSummary}
        raw
        signature={signature}
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

  return (
    <div className="relative min-w-0">
      <ToolErrorMarker status={props.part.status} />
      {frame}
    </div>
  );
}

function ToolSignature(props: {
  name: string;
  preview: string | null;
  running: boolean;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const shimmering = props.running && !searchActive;

  return (
    <>
      <ShimmerText
        active={shimmering}
        aria-label={props.running ? `${props.name} (running)` : undefined}
        as="strong"
        className={cn(
          "shrink-0 font-bold",
          !shimmering && "text-dashboard-text",
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

function ToolErrorMarker(props: {
  status: TranscriptViewToolCallPart["status"];
}) {
  if (props.status !== "error") return null;
  return (
    <span
      aria-label="Tool failed"
      className="absolute -left-[1.95rem] top-0.5 z-[1] grid size-6 place-items-center rounded border border-rose-300/40 bg-[#071012] text-rose-200 shadow-[0_0_0_3px_#050507,0_8px_20px_rgba(0,0,0,0.3)]"
      role="img"
    >
      <TriangleAlert size={12} strokeWidth={2.2} />
    </span>
  );
}

function ToolBody(props: { children: ReactNode; label?: string }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden border-t border-white/10 py-2">
      {props.label ? (
        <div className="pb-2 font-mono text-xs font-bold uppercase leading-none text-[#9a8fd0]">
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
