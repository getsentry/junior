import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { codeToHtml, type BundledLanguage } from "shiki/bundle/web";

import {
  canRenderStructuredMarkup,
  detectLanguage,
  formatBytes,
  formatMessageOffset,
  formatMessageTimestamp,
  formatMs,
  formatUsage,
  parseMarkdownBlocks,
  parseMarkupNodes,
  requesterLabel,
  stringifyPartValue,
  turnMessageCount,
  turnToolCallCount,
  unavailableTranscriptLabel,
  visualStatusForSession,
} from "./format";
import { ActivityIndicator } from "./components";
import type {
  CodeBlock,
  ConversationTurn,
  MarkupNode,
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

/** Render a transcript-shaped loading state for route transitions. */
export function TranscriptLoading() {
  return (
    <div className="transcript-loading">
      <div className="transcript-skeleton" />
      <div className="transcript-skeleton short" />
      <div className="transcript-skeleton" />
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
      <div className="transcript-empty">
        No transcript is available for this conversation.
      </div>
    );
  }

  return (
    <div className="transcript">
      <TranscriptToolbar value={view} onChange={setView} />
      {hasRedactedTurns ? <TranscriptPrivacyNotice /> : null}
      {props.turns.map((turn) => (
        <TurnTranscript key={turn.id} turn={turn} view={view} />
      ))}
    </div>
  );
}

function TranscriptPrivacyNotice() {
  return (
    <div className="transcript-privacy-notice">
      Transcript hidden because this conversation is not public.
    </div>
  );
}

function TurnTranscript(props: {
  turn: ConversationTurn;
  view: TranscriptViewMode;
}) {
  return (
    <section
      className={`turn-transcript status-${visualStatusForSession(props.turn)}`}
    >
      <TurnHeader turn={props.turn} />
      <TurnEvents turn={props.turn} view={props.view} />
    </section>
  );
}

function TurnHeader(props: { turn: ConversationTurn }) {
  return (
    <div className="turn-transcript-header">
      <div>
        <div className="section-title">
          Turn {props.turn.traceId ?? "trace unavailable"}
        </div>
        <div className="turn-actor">{turnActorLabel(props.turn)}</div>
        <div className="turn-meta">
          {turnMeta(props.turn).join(" · ")}
          {props.turn.sentryTraceUrl ? (
            <>
              {" · "}
              <a
                className="inline-link"
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
      <ActivityIndicator status={visualStatusForSession(props.turn)} />
    </div>
  );
}

function TurnEvents(props: {
  turn: ConversationTurn;
  view: TranscriptViewMode;
}) {
  return (
    <div className="turn-events">
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
        <div className="transcript-empty">
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
    <article className={`transcript-message ${props.message.role}`}>
      <div className="transcript-role">
        <span className="transcript-role-name">{props.message.role}</span>
        {meta.map((value) => (
          <span className="transcript-meta" key={value}>
            {value}
          </span>
        ))}
      </div>
      <div className="redacted-parts">
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
    <div className="redacted-row">
      <span className="redacted-row-label">{props.label}</span>
      {props.meta ? (
        <span className="redacted-row-meta">{props.meta}</span>
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
          <strong>{toolName}</strong>
          {props.call?.inputKeys?.length ? (
            <code>({props.call.inputKeys.join(", ")})</code>
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

function TranscriptToolbar(props: {
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  return (
    <div className="flex items-center justify-end pb-2 font-mono text-[0.78rem] leading-none">
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
      className="inline-flex items-center gap-1 text-[var(--muted)]"
      aria-label="Transcript view"
    >
      {options.map((option) => (
        <button
          className={`cursor-pointer border-0 bg-transparent px-1.5 py-1 uppercase tracking-normal underline-offset-4 ${
            props.value === option
              ? "text-[var(--green)] underline decoration-[var(--green)]"
              : "text-[var(--muted)]"
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
      className={`transcript-message ${props.message.role}`}
      onCopy={(event) => {
        if (props.view !== "rich" || !rawText) return;
        event.clipboardData.setData("text/plain", rawText);
        event.preventDefault();
      }}
    >
      <div className="transcript-role">
        <span className="transcript-role-name">{props.message.role}</span>
        <span className="transcript-meta">
          {formatMessageTimestamp(props.message.timestamp)}
        </span>
        {offset ? <span className="transcript-meta">{offset}</span> : null}
      </div>
      {props.view === "raw" ? (
        <HighlightedCode
          code={rawText || "{}"}
          language={detectLanguage(rawText)}
        />
      ) : (
        <div className="transcript-parts">
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

function countStructuredBlockChildren(block: CodeBlock): number {
  if (!canRenderStructuredMarkup(block.language)) return 1;
  const rootCount = parseMarkupNodes(block.code, block.language).length;
  return rootCount > 0 ? rootCount : 1;
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
      <details className="thinking-part">
        <summary className="thinking-part-header">
          <span>thinking</span>
          <span>{previewToolValue(value)}</span>
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
    <details className={`tool-part ${part.type}`}>
      <summary className="tool-part-header">
        <span>{part.type}</span>
        <strong>{part.name ?? part.id ?? "unknown"}</strong>
        <span>{previewToolValue(value)}</span>
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
      <ToolFrame meta={meta} raw signature={<strong>{toolName}</strong>}>
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
          <strong>{toolName}</strong>
          {isPreviewableValue(input) ? <code>({args})</code> : null}
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
      <span className="tool-signature">{props.signature}</span>
      <span className="tool-meta">{props.meta.join(" · ")}</span>
    </>
  );

  if (props.raw) {
    return (
      <div className="tool-part tool-invocation transcript-tool">
        <div className="tool-part-header raw !cursor-default">{header}</div>
        {props.children}
      </div>
    );
  }

  return (
    <details className="tool-part tool-invocation transcript-tool">
      <summary className="tool-part-header">{header}</summary>
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
    <div className={`tool-io ${props.padded === false ? "" : "!py-3"}`}>
      {props.label ? <div className="tool-io-label">{props.label}</div> : null}
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
      {props.index > 0 ? <span className="text-[var(--dim)]">, </span> : null}
      <span className="text-[var(--amber)]">{props.name}</span>
      <span className="text-[var(--dim)]">: </span>
      <ToolArgValue value={props.value} />
    </span>
  );
}

function ToolArgValue(props: { value: string }) {
  return <span className="text-[var(--muted)]">{props.value}</span>;
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
    <div className="transcript-text">
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

function StructuredMarkup(props: {
  block: CodeBlock;
  firstChildIndex: number;
  lastChildIndex: number;
}) {
  const nodes = parseMarkupNodes(props.block.code, props.block.language);
  if (nodes.length === 0) {
    return (
      <HighlightedCode
        code={props.block.code}
        language={props.block.language}
      />
    );
  }

  return (
    <>
      {nodes.map((node, index) => (
        <div className="markup-tree" key={index}>
          <MarkupNodeView
            defaultOpen={props.firstChildIndex + index === props.lastChildIndex}
            node={node}
          />
        </div>
      ))}
    </>
  );
}

function MarkupNodeView(props: { defaultOpen?: boolean; node: MarkupNode }) {
  if (props.node.type === "text") {
    return <div className="markup-text">{props.node.text.trim()}</div>;
  }

  const children = props.node.children;
  const hasChildren = children.length > 0;
  const attributes = props.node.attributes.map(([name, value]) => (
    <span className="markup-attribute" key={name}>
      {name}=<span className="markup-attribute-value">"{value}"</span>
    </span>
  ));

  if (!hasChildren) {
    return (
      <div className="markup-leaf">
        <span className="markup-bracket">&lt;</span>
        <span className="markup-tag">{props.node.tagName}</span>
        {attributes}
        <span className="markup-bracket"> /&gt;</span>
      </div>
    );
  }

  return (
    <details className="markup-node" open={props.defaultOpen ?? true}>
      <summary className="markup-summary">
        <span className="markup-toggle" aria-hidden="true" />
        <span className="markup-bracket">&lt;</span>
        <span className="markup-tag">{props.node.tagName}</span>
        {attributes}
        <span className="markup-open-bracket">&gt;</span>
        <span className="markup-collapsed-bracket"> /&gt;</span>
      </summary>
      <div className="markup-children">
        {children.map((child, index) => (
          <MarkupNodeView
            defaultOpen={index === children.length - 1}
            key={index}
            node={child}
          />
        ))}
      </div>
      <div className="markup-close" role="button" tabIndex={0}>
        <span className="markup-bracket">&lt;/</span>
        <span className="markup-tag">{props.node.tagName}</span>
        <span className="markup-bracket">&gt;</span>
      </div>
    </details>
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

function HighlightedCode(props: { code: string; language: BundledLanguage }) {
  const highlighted = useQuery({
    queryKey: ["highlight", props.language, props.code],
    queryFn: async () =>
      codeToHtml(props.code, {
        lang: props.language,
        theme: "github-dark",
      }),
    staleTime: Infinity,
  });

  if (!highlighted.data) {
    return (
      <pre className="highlighted-code pending">
        <code>{props.code}</code>
      </pre>
    );
  }

  return (
    <div
      className="highlighted-code"
      dangerouslySetInnerHTML={{ __html: highlighted.data }}
    />
  );
}
