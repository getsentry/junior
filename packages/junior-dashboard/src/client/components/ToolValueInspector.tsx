import { useState, type ReactNode } from "react";

import { stringifyPartValue } from "../format";
import { cn } from "../styles";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

const LONG_STRING_LENGTH = 260;
const TABLE_KEY_LIMIT = 6;

/** Render tool payloads as dense key/value rows instead of raw JSON blobs. */
export function ToolValueInspector(props: {
  emptyLabel?: string;
  value: unknown;
}) {
  if (props.value === undefined) {
    return <EmptyValue label={props.emptyLabel ?? "No payload"} />;
  }

  if (isRecord(props.value)) {
    const entries = Object.entries(props.value);
    if (entries.length === 0) {
      return <EmptyValue label={props.emptyLabel ?? "Empty object"} />;
    }
    return <KeyValueRows depth={0} entries={entries} />;
  }

  return (
    <KeyValueRows
      depth={0}
      entries={[[Array.isArray(props.value) ? "items" : "value", props.value]]}
    />
  );
}

function KeyValueRows(props: {
  depth: number;
  entries: Array<[string, unknown]>;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 overflow-hidden border border-white/10",
        props.depth === 0 ? "bg-white/[0.015]" : "bg-black/15",
      )}
    >
      {props.entries.map(([key, value]) => (
        <KeyValueRow depth={props.depth} key={key} name={key} value={value} />
      ))}
    </div>
  );
}

function KeyValueRow(props: { depth: number; name: string; value: unknown }) {
  return (
    <div
      className={cn(
        "grid min-w-0 border-t border-white/8 first:border-t-0 max-sm:grid-cols-1",
        props.depth === 0
          ? "grid-cols-[8rem_minmax(0,1fr)]"
          : "grid-cols-[7rem_minmax(0,1fr)]",
      )}
    >
      <div
        className={cn(
          "min-w-0 break-words border-r border-white/8 bg-black/20 font-mono leading-snug text-[#777] max-sm:border-b max-sm:border-r-0 max-sm:pb-1",
          props.depth === 0
            ? "px-2 py-2 text-[0.72rem]"
            : "px-2 py-1.5 text-[0.7rem]",
        )}
      >
        <HighlightText text={props.name} />
      </div>
      <div
        className={cn(
          "min-w-0 text-[0.86rem] leading-relaxed text-[#d6d6d6] max-sm:px-2 max-sm:pt-1",
          props.depth === 0 ? "px-3 py-2" : "px-2.5 py-1.5",
        )}
      >
        <StructuredValue
          depth={props.depth}
          name={props.name}
          value={props.value}
        />
      </div>
    </div>
  );
}

function StructuredValue(props: {
  depth: number;
  name?: string;
  value: unknown;
}) {
  const value = props.value;

  if (value == null) {
    return <span className="font-mono text-[#777]">null</span>;
  }

  if (typeof value === "string") {
    return <StringValue text={value} />;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="font-mono text-white">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    return <ArrayValue depth={props.depth} name={props.name} value={value} />;
  }

  if (isRecord(value)) {
    return <ObjectValue depth={props.depth} name={props.name} value={value} />;
  }

  return <StringValue text={stringifyPartValue(value)} />;
}

function StringValue(props: { text: string }) {
  const text = props.text;
  if (text.length === 0) {
    return <span className="font-mono text-[#777]">empty string</span>;
  }

  const multiline = text.includes("\n");
  if (text.length > LONG_STRING_LENGTH || multiline) {
    const preview = multiline
      ? firstLine(text)
      : text.slice(0, LONG_STRING_LENGTH).trimEnd();
    return (
      <details className="min-w-0">
        <summary className="cursor-pointer list-none break-words font-mono text-white transition-colors hover:text-[#d8ccff] [&::-webkit-details-marker]:hidden">
          <HighlightText
            text={`${preview}${preview.length < text.length ? "..." : ""}`}
          />
        </summary>
        <pre className="mt-2 max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-words border-l border-white/12 pl-3 font-mono text-[0.82rem] leading-relaxed text-white">
          <HighlightText text={text} />
        </pre>
      </details>
    );
  }

  return (
    <span className="break-words font-mono text-white">
      <HighlightText text={text} />
    </span>
  );
}

function ArrayValue(props: { depth: number; name?: string; value: unknown[] }) {
  const value = props.value;
  if (value.length === 0) {
    return <span className="font-mono text-[#777]">empty array</span>;
  }

  if (canRenderPrimitiveChips(value)) {
    return (
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {value.map((item, index) => (
          <span
            className="max-w-full break-words border border-white/10 bg-black/20 px-1.5 py-0.5 font-mono text-[0.78rem] text-white"
            key={index}
          >
            <HighlightText text={String(item)} />
          </span>
        ))}
      </div>
    );
  }

  if (canRenderObjectTable(value)) {
    return <ObjectTable rows={value as Record<string, unknown>[]} />;
  }

  return (
    <NestedDetails
      count={`${value.length} item${value.length === 1 ? "" : "s"}`}
      depth={props.depth}
      label={props.name ?? "array"}
    >
      <div className="grid min-w-0">
        {value.map((item, index) => (
          <KeyValueRow
            depth={props.depth + 1}
            key={index}
            name={String(index)}
            value={item}
          />
        ))}
      </div>
    </NestedDetails>
  );
}

function ObjectValue(props: {
  depth: number;
  name?: string;
  value: Record<string, unknown>;
}) {
  const entries = Object.entries(props.value);
  if (entries.length === 0) {
    return <span className="font-mono text-[#777]">empty object</span>;
  }

  return (
    <NestedDetails
      count={`${entries.length} key${entries.length === 1 ? "" : "s"}`}
      depth={props.depth}
      label={props.depth === 0 ? undefined : (props.name ?? "object")}
    >
      <KeyValueRows depth={props.depth + 1} entries={entries} />
    </NestedDetails>
  );
}

function NestedDetails(props: {
  children: ReactNode;
  count: string;
  depth: number;
  label?: string;
}) {
  const search = useTranscriptSearch();
  const [open, setOpen] = useState(search.active || props.depth === 0);

  return (
    <details
      className="min-w-0"
      onToggle={(event) => {
        if (event.currentTarget !== event.target) return;
        setOpen(event.currentTarget.open);
      }}
      open={search.active || open}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 font-mono text-[0.8rem] text-[#b8b8b8] transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        <span className="border border-white/10 bg-black/20 px-1.5 py-0.5 text-[#d6d6d6]">
          <HighlightText text={props.count} />
        </span>
        {props.label ? (
          <span className="text-[#777]">
            <HighlightText text={props.label} />
          </span>
        ) : null}
      </summary>
      <div
        className={cn(
          "mt-2 min-w-0",
          props.depth > 0 && "ml-1 border-l border-[#beaaff]/18 pl-3",
        )}
      >
        {props.children}
      </div>
    </details>
  );
}

function ObjectTable(props: { rows: Array<Record<string, unknown>> }) {
  const keys = tableKeys(props.rows);

  return (
    <div className="min-w-0 overflow-auto border border-white/10 bg-black/20">
      <table className="w-full min-w-[32rem] border-collapse text-left font-mono text-[0.78rem] leading-snug">
        <thead className="bg-[#121118] text-[#9a8fd0]">
          <tr>
            {keys.map((key) => (
              <th
                className="border-b border-white/10 px-2 py-1.5 font-bold"
                key={key}
              >
                <HighlightText text={key} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/8">
          {props.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {keys.map((key) => (
                <td
                  className="max-w-[18rem] px-2 py-1.5 align-top text-[#d6d6d6]"
                  key={key}
                >
                  <CompactValue value={row[key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompactValue(props: { value: unknown }) {
  const value = props.value;
  if (value == null) return <span className="text-[#777]">null</span>;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return (
      <span className="break-words text-white">
        <HighlightText text={truncate(String(value), 96)} />
      </span>
    );
  }
  return (
    <span className="break-words text-[#b8b8b8]">
      <HighlightText
        text={truncate(stringifyPartValue(value).replace(/\s+/g, " "), 96)}
      />
    </span>
  );
}

function EmptyValue(props: { label: string }) {
  return (
    <div className="border-y border-white/8 py-2 font-mono text-[0.82rem] text-[#777]">
      {props.label}
    </div>
  );
}

function canRenderPrimitiveChips(value: unknown[]): boolean {
  return (
    value.length <= 12 &&
    value.every(
      (item) =>
        item == null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    )
  );
}

function canRenderObjectTable(value: unknown[]): boolean {
  return (
    value.length > 0 &&
    value.length <= 25 &&
    value.every((item) => isRecord(item)) &&
    tableKeys(value as Record<string, unknown>[]).length > 0
  );
}

function tableKeys(rows: Array<Record<string, unknown>>): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key);
      if (keys.length >= TABLE_KEY_LIMIT) return keys;
    }
  }
  return keys;
}

function firstLine(text: string): string {
  return (
    text.split(/\r?\n/, 1)[0]?.slice(0, LONG_STRING_LENGTH).trimEnd() ?? ""
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, Math.max(0, maxLength - 3))}...`
    : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
