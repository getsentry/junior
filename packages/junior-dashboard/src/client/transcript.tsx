import { useState, type ReactNode } from "react";

import {
  countStructuredBlockChildren,
  HighlightedCode,
  StructuredMarkup,
} from "./code";
import {
  canRenderStructuredMarkup,
  detectLanguage,
  formatBytes,
  formatMessageOffset,
  formatMessageTimestamp,
  formatMs,
  formatUsage,
  parseMarkdownBlocks,
  requesterLabel,
  stringifyPartValue,
  turnMessageCount,
  turnToolCallCount,
  unavailableTranscriptLabel,
  visualStatusForSession,
} from "./format";
import { StatusBadge } from "./components";
import { cn } from "./styles";
import type {
  ConversationTurn,
  TranscriptMessage,
  TranscriptPart,
} from "./types";

type RenderedTranscriptPart =
  | { kind: "part"; part: TranscriptPart }
  | { kind: "tool"; call?: TranscriptPart; result?: TranscriptPart };

type RenderedTranscriptEntry =
  | { kind: "message"; message: TranscriptMessage }
  | RenderedToolEntry;

type RenderedToolEntry = {
  call?: TranscriptPart;
  kind: "tool";
  result?: TranscriptPart;
  resultTimestamp?: number;
  timestamp?: number;
};

type TranscriptViewMode = "raw" | "rich";

function mutedMonoClass(size = "text-[0.84rem]"): string {
  return cn("font-mono leading-relaxed text-[#b8b8b8]", size);
}

function transcriptEmptyClass(): string {
  return "border border-white/10 bg-[#050505] p-4 font-mono text-[0.88rem] leading-relaxed text-[#b8b8b8]";
}

/** Render a transcript-shaped loading state for route transitions. */
export function TranscriptLoading() {
  return (
    <div className="grid gap-3">
      <div className="min-h-28 animate-pulse border border-white/10 bg-[#0b0b0b]" />
      <div className="min-h-[4.5rem] animate-pulse border border-white/10 bg-[#0b0b0b]" />
      <div className="min-h-28 animate-pulse border border-white/10 bg-[#0b0b0b]" />
    </div>
  );
}

function isToolCall(part: TranscriptPart): boolean {
  return part.type === "tool_call";
}

function isToolResult(part: TranscriptPart): boolean {
  return part.type === "tool_result";
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameToolInvocation(
  call: TranscriptPart,
  result: TranscriptPart,
): boolean {
  if (call.id && result.id) return call.id === result.id;
  if (call.name && result.name) return call.name === result.name;
  return false;
}

function groupTranscriptParts(
  parts: TranscriptPart[],
): RenderedTranscriptPart[] {
  const grouped: RenderedTranscriptPart[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < parts.length; index += 1) {
    if (consumed.has(index)) continue;

    const part = parts[index]!;
    if (isToolCall(part)) {
      const resultIndex = parts.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          !consumed.has(candidateIndex) &&
          isToolResult(candidate) &&
          sameToolInvocation(part, candidate),
      );
      if (resultIndex >= 0) {
        consumed.add(resultIndex);
        grouped.push({ kind: "tool", call: part, result: parts[resultIndex] });
      } else {
        grouped.push({ kind: "tool", call: part });
      }
      continue;
    }

    if (isToolResult(part)) {
      grouped.push({ kind: "tool", result: part });
      continue;
    }

    grouped.push({ kind: "part", part });
  }

  return grouped;
}

function findToolEntry(
  entries: RenderedTranscriptEntry[],
  result: TranscriptPart,
): RenderedToolEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "tool" || entry.result) continue;
    if (!entry.call || sameToolInvocation(entry.call, result)) {
      return entry;
    }
  }
  return undefined;
}

function groupTranscriptMessages(
  messages: TranscriptMessage[],
): RenderedTranscriptEntry[] {
  const entries: RenderedTranscriptEntry[] = [];

  for (const message of messages) {
    let messageParts: TranscriptPart[] = [];
    const flushMessage = () => {
      if (messageParts.length === 0) return;
      entries.push({
        kind: "message",
        message: { ...message, parts: messageParts },
      });
      messageParts = [];
    };

    for (const part of message.parts) {
      if (isToolCall(part)) {
        flushMessage();
        entries.push({
          call: part,
          kind: "tool",
          timestamp: message.timestamp,
        });
        continue;
      }

      if (isToolResult(part)) {
        flushMessage();
        const entry = findToolEntry(entries, part);
        if (entry) {
          entry.result = part;
          entry.resultTimestamp = message.timestamp;
        } else {
          entries.push({
            kind: "tool",
            result: part,
            resultTimestamp: message.timestamp,
          });
        }
        continue;
      }

      messageParts.push(part);
    }

    flushMessage();
  }

  return entries;
}

/** Render ordered conversation turns as message, thinking, and tool-call events. */
export function Transcript(props: { turns: ConversationTurn[] }) {
  const [view, setView] = useState<TranscriptViewMode>("rich");
  const hasRedactedTurns = props.turns.some((turn) => turn.transcriptRedacted);

  if (props.turns.length === 0) {
    return (
      <div className={transcriptEmptyClass()}>
        No transcript is available for this conversation.
      </div>
    );
  }

  return (
    <div className="grid min-w-0">
      <TranscriptHeader
        redacted={hasRedactedTurns}
        value={view}
        onChange={setView}
      />
      {props.turns.map((turn) => (
        <TurnTranscript key={turn.id} turn={turn} view={view} />
      ))}
    </div>
  );
}

function TurnTranscript(props: {
  turn: ConversationTurn;
  view: TranscriptViewMode;
}) {
  const status = visualStatusForSession(props.turn);

  return (
    <section className="grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)] gap-3 border-t border-white/10 py-4 first:border-t-0">
      <div className="flex flex-col items-center pt-2" aria-hidden="true">
        <span className={turnMarkerClass(status)} />
        <span className="mt-2 w-px flex-1 bg-[#beaaff]/20" />
      </div>
      <div className="min-w-0">
        <TurnHeader turn={props.turn} />
        <TurnEvents turn={props.turn} view={props.view} />
      </div>
    </section>
  );
}

function turnMarkerClass(
  status: ReturnType<typeof visualStatusForSession>,
): string {
  return cn(
    "size-2.5 shrink-0 border",
    status === "active" && "border-emerald-300 bg-emerald-300",
    status === "hung" && "border-amber-300 bg-amber-300",
    status === "failed" && "border-rose-300 bg-rose-300",
    status === "idle" && "border-[#beaaff]/70 bg-[#beaaff]/50",
  );
}

function transcriptMessageClass(role: string): string {
  return cn(
    "grid min-w-0 gap-2",
    role === "assistant" && "text-white",
    role === "toolResult" && "text-[#b8b8b8]",
    role === "tool_result" && "text-[#b8b8b8]",
    role !== "assistant" &&
      role !== "toolResult" &&
      role !== "tool_result" &&
      "text-[#f4f4f4]",
  );
}

function transcriptRoleClass(): string {
  return "flex flex-wrap items-baseline gap-2 font-mono text-[0.88rem] uppercase leading-snug";
}

function toolFrameClass(): string {
  return "border border-[#beaaff]/20 bg-[#111] transition-colors hover:border-[#beaaff]/45 hover:bg-[rgba(190,170,255,0.06)]";
}

function toolHeaderClass(): string {
  return "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 font-mono text-[0.86rem] leading-tight text-[#b8b8b8] hover:bg-[rgba(190,170,255,0.07)] max-md:grid-cols-1 max-md:gap-1";
}

function TurnHeader(props: { turn: ConversationTurn }) {
  const status = visualStatusForSession(props.turn);

  return (
    <div className="flex items-start justify-between gap-3 max-md:flex-col">
      <div className="min-w-0">
        <div className="text-[1.05rem] font-bold leading-tight tracking-normal">
          Turn{" "}
          <span className="break-all">
            {props.turn.traceId ?? "trace unavailable"}
          </span>
        </div>
        <div className="mt-1 font-mono text-[0.84rem] leading-relaxed text-white">
          {turnActorLabel(props.turn)}
        </div>
        <div className={mutedMonoClass()}>
          {turnMeta(props.turn).join(" · ")}
          {props.turn.sentryTraceUrl ? (
            <>
              {" · "}
              <a
                className="text-white no-underline hover:underline"
                href={props.turn.sentryTraceUrl}
                rel="noreferrer"
                target="_blank"
              >
                View in Sentry
              </a>
            </>
          ) : null}
        </div>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function TurnEvents(props: {
  turn: ConversationTurn;
  view: TranscriptViewMode;
}) {
  return (
    <div className="grid gap-3 pt-3">
      {props.turn.transcriptAvailable ? (
        groupTranscriptMessages(props.turn.transcript).map((entry, index) =>
          entry.kind === "tool" ? (
            <TranscriptToolView
              call={entry.call}
              key={`${props.turn.id}:${index}`}
              result={entry.result}
              resultTimestamp={entry.resultTimestamp}
              timestamp={entry.timestamp}
              view={props.view}
            />
          ) : (
            <TranscriptMessageView
              key={`${props.turn.id}:${index}`}
              message={entry.message}
              turn={props.turn}
              view={props.view}
            />
          ),
        )
      ) : props.turn.transcriptRedacted &&
        props.turn.transcriptMetadata?.length ? (
        <RedactedTranscriptView turn={props.turn} />
      ) : (
        <div className={transcriptEmptyClass()}>
          {unavailableTranscriptLabel(props.turn)}
        </div>
      )}
    </div>
  );
}

function RedactedTranscriptView(props: { turn: ConversationTurn }) {
  return (
    <>
      {groupTranscriptMessages(props.turn.transcriptMetadata ?? []).map(
        (entry, index) =>
          entry.kind === "tool" ? (
            <RedactedToolView
              call={entry.call}
              key={`${props.turn.id}:redacted:${index}`}
              result={entry.result}
              resultTimestamp={entry.resultTimestamp}
              timestamp={entry.timestamp}
            />
          ) : (
            <RedactedMessageView
              key={`${props.turn.id}:redacted:${index}`}
              message={entry.message}
              turn={props.turn}
            />
          ),
      )}
    </>
  );
}

function RedactedMessageView(props: {
  message: TranscriptMessage;
  turn: ConversationTurn;
}) {
  const offset = formatMessageOffset(props.turn, props.message.timestamp);
  const meta = [
    formatMessageTimestamp(props.message.timestamp),
    offset,
    redactedMessageSummary(props.message),
  ].filter(isString);

  return (
    <article className={transcriptMessageClass(props.message.role)}>
      <div className={transcriptRoleClass()}>
        <span className="font-extrabold">{props.message.role}</span>
        {meta.map((value) => (
          <span className="text-[#888]" key={value}>
            {value}
          </span>
        ))}
      </div>
      <div className="grid min-w-0 gap-2 font-mono text-[0.9rem] leading-snug text-[#b8b8b8]">
        {props.message.parts.map((part, index) => (
          <RedactedPartLine key={index} part={part} />
        ))}
      </div>
    </article>
  );
}

function RedactedPartLine(props: { part: TranscriptPart }) {
  if (props.part.type === "text") {
    return (
      <RedactedMetadataRow
        label="redacted"
        meta={redactedMessageSize(props.part)}
      />
    );
  }
  if (props.part.type === "thinking") {
    return <RedactedMetadataRow label="redacted" />;
  }
  return <RedactedMetadataRow label="redacted" />;
}

function RedactedMetadataRow(props: { label: string; meta?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-white/10 py-2 first:border-t-0 max-md:grid-cols-1">
      <span className="min-w-0 break-words text-white">{props.label}</span>
      {props.meta ? (
        <span className="min-w-0 break-words text-right text-[#888] max-md:text-left">
          {props.meta}
        </span>
      ) : null}
    </div>
  );
}

function RedactedToolView(props: {
  call?: TranscriptPart;
  result?: TranscriptPart;
  resultTimestamp?: number;
  timestamp?: number;
}) {
  const toolName =
    props.call?.name ??
    props.result?.name ??
    props.call?.id ??
    props.result?.id ??
    "unknown";
  const duration =
    typeof props.timestamp === "number" &&
    typeof props.resultTimestamp === "number" &&
    props.resultTimestamp >= props.timestamp
      ? formatMs(props.resultTimestamp - props.timestamp)
      : undefined;
  const meta = [
    props.timestamp ? formatMessageTimestamp(props.timestamp) : undefined,
    duration,
    props.result ? undefined : "missing result",
  ].filter(isString);

  return (
    <ToolFrame
      meta={meta}
      raw
      signature={
        <>
          <strong className="min-w-0 break-words font-bold text-white">
            {toolName}
          </strong>
          {props.call?.inputKeys?.length ? (
            <code className="min-w-0 break-words font-[inherit] text-[#b8b8b8]">
              ({props.call.inputKeys.join(", ")})
            </code>
          ) : null}
        </>
      }
    />
  );
}

function redactedMessageSummary(message: TranscriptMessage): string {
  return message.parts.length > 0 ? "redacted" : "content unavailable";
}

function redactedMessageSize(part: TranscriptPart): string | undefined {
  if (typeof part.bytes === "number") return formatBytes(part.bytes);
  return typeof part.chars === "number" ? `${part.chars} chars` : undefined;
}

function TranscriptHeader(props: {
  onChange(value: TranscriptViewMode): void;
  redacted: boolean;
  value: TranscriptViewMode;
}) {
  return (
    <div className="mb-1 flex min-w-0 items-start justify-between gap-3 border-b border-[#beaaff]/20 pb-3 font-mono leading-none max-md:flex-col">
      <div className="min-w-0">
        <div className="text-[0.78rem] uppercase text-[#888]">Transcript</div>
        {props.redacted ? (
          <div className="mt-2 break-words text-[0.88rem] leading-relaxed text-[#b8b8b8]">
            Hidden because this conversation is not public.
          </div>
        ) : null}
      </div>
      <TranscriptViewToggle value={props.value} onChange={props.onChange} />
    </div>
  );
}

function TranscriptViewToggle(props: {
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  const options: TranscriptViewMode[] = ["rich", "raw"];
  return (
    <div
      className="inline-flex items-center gap-1 text-[#888]"
      aria-label="Transcript view"
    >
      {options.map((option) => (
        <button
          className={`cursor-pointer border-0 bg-transparent px-1.5 py-1 uppercase tracking-normal underline-offset-4 ${
            props.value === option
              ? "text-white underline decoration-white"
              : "text-[#888] hover:text-white"
          }`}
          key={option}
          onClick={() => props.onChange(option)}
          type="button"
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function turnActorLabel(turn: ConversationTurn): string {
  return requesterLabel(turn.requesterIdentity, turn.requester) ?? "unknown";
}

function turnMeta(turn: ConversationTurn): string[] {
  return [
    formatMs(turn.cumulativeDurationMs),
    formatUsage(turn.cumulativeUsage),
    `${turnMessageCount(turn)} messages`,
    `${turnToolCallCount(turn)} tool calls`,
  ].filter((value) => value && value !== "none");
}

function TranscriptMessageView(props: {
  message: TranscriptMessage;
  turn: ConversationTurn;
  view: TranscriptViewMode;
}) {
  const offset = formatMessageOffset(props.turn, props.message.timestamp);
  const renderedParts = groupTranscriptParts(props.message.parts);
  const rawText = messageRawText(props.message);
  const totalRenderedChildren = renderedParts.reduce(
    (count, part) => count + countRenderedTranscriptChildren(part),
    0,
  );
  let seenRenderedChildren = 0;

  return (
    <article
      className={transcriptMessageClass(props.message.role)}
      onCopy={(event) => {
        if (props.view !== "rich" || !rawText) return;
        event.clipboardData.setData("text/plain", rawText);
        event.preventDefault();
      }}
    >
      <div className={transcriptRoleClass()}>
        <span className="font-extrabold">{props.message.role}</span>
        <span className="text-[#888]">
          {formatMessageTimestamp(props.message.timestamp)}
        </span>
        {offset ? <span className="text-[#888]">{offset}</span> : null}
      </div>
      {props.view === "raw" ? (
        <HighlightedCode
          code={rawText || "{}"}
          language={detectLanguage(rawText)}
        />
      ) : (
        <div className="grid min-w-0 gap-2">
          {renderedParts.map((part, index) => {
            const firstChildIndex = seenRenderedChildren;
            seenRenderedChildren += countRenderedTranscriptChildren(part);
            return (
              <TranscriptPartView
                firstChildIndex={firstChildIndex}
                key={index}
                lastChildIndex={totalRenderedChildren - 1}
                part={part}
              />
            );
          })}
        </div>
      )}
    </article>
  );
}

function messageRawText(message: TranscriptMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "thinking") return stringifyPartValue(part.output);
      if (part.type === "tool_call") {
        return [
          `tool_call ${part.name ?? part.id ?? "unknown"}`,
          stringifyPartValue(part.input),
        ]
          .filter(isString)
          .join("\n");
      }
      if (part.type === "tool_result") {
        return [
          `tool_result ${part.name ?? part.id ?? "unknown"}`,
          stringifyPartValue(part.output),
        ]
          .filter(isString)
          .join("\n");
      }
      return stringifyPartValue(part.output ?? part.input ?? part.text ?? part);
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function countTextRenderedChildren(text: string): number {
  return parseMarkdownBlocks(text).reduce((count, block) => {
    return count + countStructuredBlockChildren(block);
  }, 0);
}

function countRenderedTranscriptChildren(part: RenderedTranscriptPart): number {
  if (part.kind === "tool") return 1;
  if (part.part.type === "text") {
    return countTextRenderedChildren(part.part.text ?? "");
  }
  return 1;
}

function TranscriptPartView(props: {
  firstChildIndex: number;
  lastChildIndex: number;
  part: RenderedTranscriptPart;
}) {
  if (props.part.kind === "tool") {
    return (
      <TranscriptToolView call={props.part.call} result={props.part.result} />
    );
  }

  const part = props.part.part;
  if (part.type === "text") {
    return (
      <TranscriptText
        firstChildIndex={props.firstChildIndex}
        lastChildIndex={props.lastChildIndex}
        text={part.text ?? ""}
      />
    );
  }

  const value = part.output;
  if (part.type === "thinking") {
    const rendered = stringifyPartValue(value);
    return (
      <details className="border border-[#beaaff]/20 bg-white/[0.03] transition-colors hover:border-[#beaaff]/45 hover:bg-[rgba(190,170,255,0.06)]">
        <summary className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-3 py-2 font-mono text-[0.8rem] leading-tight text-[#888] hover:bg-[rgba(190,170,255,0.07)] max-md:grid-cols-1 max-md:gap-1">
          <span className="uppercase text-[#b8b8b8]">thinking</span>
          <span className="min-w-0 truncate">{previewToolValue(value)}</span>
        </summary>
        <HighlightedCode
          code={rendered || "{}"}
          language={detectLanguage(rendered)}
        />
      </details>
    );
  }

  const rendered = stringifyPartValue(value);
  return (
    <details className={toolFrameClass()}>
      <summary className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 font-mono text-[0.86rem] leading-tight text-[#b8b8b8] hover:bg-white/[0.04] max-md:grid-cols-1 max-md:gap-1">
        <span className="text-[#888]">{part.type}</span>
        <strong className="min-w-0 break-words font-bold text-white">
          {part.name ?? part.id ?? "unknown"}
        </strong>
        <span className="min-w-0 break-words text-right max-md:text-left">
          {previewToolValue(value)}
        </span>
      </summary>
      <HighlightedCode code={rendered || "{}"} language="json" />
    </details>
  );
}

function TranscriptToolView(props: {
  call?: TranscriptPart;
  result?: TranscriptPart;
  resultTimestamp?: number;
  timestamp?: number;
  view?: TranscriptViewMode;
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

function ToolFrame(props: {
  children?: ReactNode;
  meta: string[];
  raw?: boolean;
  signature: ReactNode;
}) {
  const header = (
    <>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5 overflow-hidden">
        {props.signature}
      </span>
      <span className="min-w-0 break-words text-right text-[#888] max-md:text-left">
        {props.meta.join(" · ")}
      </span>
    </>
  );

  if (props.raw) {
    return (
      <div className={toolFrameClass()}>
        <div className={cn(toolHeaderClass(), "cursor-default")}>{header}</div>
        {props.children}
      </div>
    );
  }

  return (
    <details className={toolFrameClass()}>
      <summary className={toolHeaderClass()}>{header}</summary>
      {props.children}
    </details>
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

function TranscriptText(props: {
  firstChildIndex: number;
  lastChildIndex: number;
  text: string;
}) {
  const blocks = parseMarkdownBlocks(props.text);
  let seenChildren = props.firstChildIndex;

  return (
    <div className="grid min-w-0 gap-2">
      {blocks.map((block, index) => {
        const firstChildIndex = seenChildren;
        const childCount = countStructuredBlockChildren(block);
        seenChildren += childCount;

        if (!canRenderStructuredMarkup(block.language)) {
          return (
            <HighlightedCode
              code={block.code}
              key={index}
              language={block.language}
            />
          );
        }

        return (
          <StructuredMarkup
            block={block}
            firstChildIndex={firstChildIndex}
            key={index}
            lastChildIndex={props.lastChildIndex}
          />
        );
      })}
    </div>
  );
}

function previewToolValue(value: unknown): string {
  if (!isPreviewableValue(value)) return "no arguments";
  const source =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, nested) =>
          typeof nested === "string" && nested.length > 80
            ? `${nested.slice(0, 77)}...`
            : nested,
        );
  return source.length > 120 ? `${source.slice(0, 117)}...` : source;
}

function isPreviewableValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}
