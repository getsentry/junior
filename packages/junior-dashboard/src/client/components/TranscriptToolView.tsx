import type { ReactNode } from "react";

import { HighlightedCode } from "../code";
import {
  formatElapsedDuration,
  formatMessageTimestamp,
  stringifyPartValue,
} from "../format";
import type { TranscriptViewToolCallPart } from "../types";
import { ToolFrame } from "./ToolFrame";
import { HighlightText } from "./transcriptSearch";

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
  const meta = [duration, timestamp].filter(isString);
  const status =
    props.part.status === "completed" ? null : (
      <ToolStatus status={props.part.status} />
    );
  const mobileSummary = duration;

  if (props.view === "raw" && hasDetails) {
    return (
      <ToolFrame
        meta={meta}
        mobileSummaryMeta={mobileSummary}
        raw
        signature={<ToolSignature name={props.part.name} status={status} />}
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
    );
  }

  return (
    <ToolFrame
      expandable={hasDetails}
      meta={meta}
      mobileSummaryMeta={mobileSummary}
      signature={<ToolSignature name={props.part.name} status={status} />}
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
}

function ToolSignature(props: { name: string; status: ReactNode }) {
  return (
    <>
      <strong className="min-w-0 break-words font-bold text-[#d6d6d6]">
        <HighlightText text={props.name} />
      </strong>
      {props.status ? (
        <>
          <span className="text-[#777]">·</span>
          {props.status}
        </>
      ) : null}
    </>
  );
}

function ToolStatus(props: { status: "error" | "running" }) {
  if (props.status === "running") {
    return (
      <span
        aria-label="running"
        className="animate-pulse text-cyan-200/70 motion-reduce:animate-none"
      >
        running
      </span>
    );
  }
  return <span className="text-rose-300">error</span>;
}

function ToolBody(props: { children: ReactNode; label?: string }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden border-t border-white/10 py-2">
      {props.label ? (
        <div className="pb-2 font-mono text-[0.68rem] font-bold uppercase leading-none text-[#9a8fd0]">
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
