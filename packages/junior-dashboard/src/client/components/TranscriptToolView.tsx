import type { ReactNode } from "react";

import { HighlightedCode } from "../code";
import {
  formatBytes,
  formatMessageTimestamp,
  formatMs,
  stringifyPartValue,
} from "../format";
import { cn } from "../styles";
import type { TranscriptViewPart } from "../types";
import { ToolFrame } from "./ToolFrame";
import { ToolValueInspector } from "./ToolValueInspector";
import { isPreviewableValue } from "./transcriptPreview";
import { HighlightText } from "./transcriptSearch";

/** Render a tool call/result pair in rich or raw transcript mode. */
export function TranscriptToolView(props: {
  call?: TranscriptViewPart;
  result?: TranscriptViewPart;
  resultTimestamp?: number;
  timestamp?: number;
  view?: "raw" | "rich";
}) {
  const toolName =
    props.call?.name ??
    props.result?.name ??
    props.call?.id ??
    props.result?.id ??
    "unknown";
  const input = toolInputPayload(props.call);
  const output = toolOutputPayload(props.result);
  const outputBytes = props.result
    ? new TextEncoder().encode(stringifyPartValue(output)).length
    : undefined;
  const duration =
    typeof props.timestamp === "number" &&
    typeof props.resultTimestamp === "number" &&
    props.resultTimestamp >= props.timestamp
      ? formatMs(props.resultTimestamp - props.timestamp)
      : undefined;
  const missingResultLabel =
    props.call?.status === "running" ? "running" : "missing result";
  const meta = [
    duration,
    props.result ? formatBytes(outputBytes) : undefined,
    props.result ? undefined : missingResultLabel,
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);
  const args = <ToolArgumentsPreview input={input} />;
  const hasExpandableContent = Boolean(props.call || props.result);
  const mobileSummaryMeta =
    duration ?? (props.call && !props.result ? missingResultLabel : undefined);

  if (props.view === "raw") {
    return (
      <ToolFrame
        meta={meta}
        mobileSummaryMeta={mobileSummaryMeta}
        raw
        signature={
          <strong className="min-w-0 break-words font-bold text-[#d6d6d6]">
            <HighlightText text={toolName} />
          </strong>
        }
      >
        <ToolBodySection>
          <HighlightedCode
            code={stringifyPartValue({
              call: props.call,
              result: props.result,
            })}
            language="json"
          />
        </ToolBodySection>
      </ToolFrame>
    );
  }

  return (
    <ToolFrame
      expandable={hasExpandableContent}
      meta={meta}
      mobileSummaryMeta={mobileSummaryMeta}
      signature={
        <>
          <strong className="min-w-0 break-words font-bold text-[#d6d6d6]">
            <HighlightText text={toolName} />
          </strong>
          {isPreviewableValue(input) ? (
            <code className="min-w-0 break-words font-[inherit] text-[#b8b8b8] max-md:hidden">
              ({args})
            </code>
          ) : null}
        </>
      }
    >
      {props.call ? (
        <ToolBodySection label="arguments">
          <ToolValueInspector emptyLabel="No arguments" value={input} />
        </ToolBodySection>
      ) : null}
      {props.result ? (
        <ToolBodySection label="result">
          <ToolValueInspector emptyLabel="No result payload" value={output} />
        </ToolBodySection>
      ) : null}
    </ToolFrame>
  );
}

function toolInputPayload(part: TranscriptViewPart | undefined): unknown {
  if (!part) return undefined;
  if (part.redacted) {
    return redactedPayload("input", part);
  }
  return part.input;
}

function toolOutputPayload(part: TranscriptViewPart | undefined): unknown {
  if (!part) return undefined;
  if (part.redacted) {
    return redactedPayload("output", part);
  }
  return part.output;
}

function redactedPayload(
  kind: "input" | "output",
  part: TranscriptViewPart,
): Record<string, unknown> {
  return {
    redacted: true,
    ...(kind === "input" && part.inputKeys ? { keys: part.inputKeys } : {}),
    ...(kind === "output" && part.outputKeys ? { keys: part.outputKeys } : {}),
    ...(kind === "input" && part.inputType ? { type: part.inputType } : {}),
    ...(kind === "output" && part.outputType ? { type: part.outputType } : {}),
    ...(kind === "input" && part.inputSizeBytes !== undefined
      ? { sizeBytes: part.inputSizeBytes }
      : {}),
    ...(kind === "output" && part.outputSizeBytes !== undefined
      ? { sizeBytes: part.outputSizeBytes }
      : {}),
    ...(kind === "input" && part.inputSizeChars !== undefined
      ? { sizeChars: part.inputSizeChars }
      : {}),
    ...(kind === "output" && part.outputSizeChars !== undefined
      ? { sizeChars: part.outputSizeChars }
      : {}),
  };
}

function ToolBodySection(props: {
  children: ReactNode;
  label?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 max-w-full overflow-hidden border-t border-white/10",
        props.padded === false ? "" : "py-2",
      )}
    >
      {props.label ? (
        <div className="pb-2 font-mono text-[0.68rem] font-bold uppercase leading-none text-[#9a8fd0]">
          {props.label}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

function ToolArgumentsPreview(props: { input: unknown }) {
  const input = props.input;
  if (input == null || input === "") return null;

  if (typeof input === "string") {
    const formatted = stringifyPartValue(input).replace(/\s+/g, " ").trim();
    return <ToolArgValue value={truncateText(formatted, 96)} />;
  }

  if (Array.isArray(input)) {
    return (
      <ToolArgValue
        value={truncateText(
          stringifyPartValue(input).replace(/\s+/g, " ").trim(),
          96,
        )}
      />
    );
  }

  if (typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).slice(
      0,
      4,
    );
    return (
      <>
        {entries.map(([key, value], index) => (
          <ToolArgEntry
            index={index}
            key={key}
            name={key}
            value={previewArgumentValue(value)}
          />
        ))}
      </>
    );
  }

  return <ToolArgValue value={truncateText(String(input), 96)} />;
}

function ToolArgEntry(props: { index: number; name: string; value: string }) {
  return (
    <span>
      {props.index > 0 ? <span className="text-[#888]">, </span> : null}
      <span className="text-[#d6d6d6]">{props.name}</span>
      <span className="text-[#888]">: </span>
      <ToolArgValue value={props.value} />
    </span>
  );
}

function ToolArgValue(props: { value: string }) {
  return <span className="text-[#b8b8b8]">{props.value}</span>;
}

function previewArgumentValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(truncateText(value, 48));
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncateText(
    stringifyPartValue(value).replace(/\s+/g, " ").trim(),
    48,
  );
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
