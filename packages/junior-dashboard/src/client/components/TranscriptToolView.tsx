import type { ReactNode } from "react";

import { HighlightedCode } from "../code";
import {
  formatBytes,
  formatMessageTimestamp,
  formatMs,
  stringifyPartValue,
} from "../format";
import { cn } from "../styles";
import type { TranscriptPart } from "../types";
import { ToolFrame } from "./ToolFrame";
import { isPreviewableValue } from "./transcriptPreview";

/** Render a tool call/result pair in rich or raw transcript mode. */
export function TranscriptToolView(props: {
  call?: TranscriptPart;
  result?: TranscriptPart;
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
  const input = props.call?.input;
  const output = props.result?.output;
  const outputBytes = props.result
    ? new TextEncoder().encode(stringifyPartValue(output)).length
    : undefined;
  const duration =
    typeof props.timestamp === "number" &&
    typeof props.resultTimestamp === "number" &&
    props.resultTimestamp >= props.timestamp
      ? formatMs(props.resultTimestamp - props.timestamp)
      : undefined;
  const meta = [
    props.timestamp ? formatMessageTimestamp(props.timestamp) : undefined,
    duration,
    props.result ? formatBytes(outputBytes) : undefined,
    props.result ? undefined : "missing result",
  ].filter(isString);
  const args = <ToolArgumentsPreview input={input} />;

  if (props.view === "raw") {
    return (
      <ToolFrame
        meta={meta}
        raw
        signature={
          <strong className="min-w-0 break-words font-bold text-white">
            {toolName}
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
      meta={meta}
      signature={
        <>
          <strong className="min-w-0 break-words font-bold text-white">
            {toolName}
          </strong>
          {isPreviewableValue(input) ? (
            <code className="min-w-0 break-words font-[inherit] text-[#b8b8b8]">
              ({args})
            </code>
          ) : null}
        </>
      }
    >
      {props.call ? (
        <ToolBodySection label="arguments">
          <HighlightedCode
            code={stringifyPartValue(input) || "{}"}
            language="json"
          />
        </ToolBodySection>
      ) : null}
      {props.result ? (
        <ToolBodySection label="result">
          <HighlightedCode
            code={stringifyPartValue(output) || "{}"}
            language="json"
          />
        </ToolBodySection>
      ) : null}
    </ToolFrame>
  );
}

function ToolBodySection(props: {
  children: ReactNode;
  label?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "border-t border-white/10 px-3",
        props.padded === false ? "" : "py-3",
      )}
    >
      {props.label ? (
        <div className="pb-2 font-mono text-[0.78rem] uppercase leading-none text-[#888]">
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
      <span className="text-white">{props.name}</span>
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
