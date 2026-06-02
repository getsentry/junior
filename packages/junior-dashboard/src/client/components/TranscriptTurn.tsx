import {
  Fragment,
  useState,
  type ClipboardEventHandler,
  type ReactNode,
} from "react";

import { HighlightedCode } from "../code";
import {
  detectLanguage,
  transcriptRoleKind,
  formatBytes,
  formatMessageTimestamp,
  formatMs,
  formatTurnDuration,
  requesterLabel,
  summarizeMessages,
  summarizeToolCalls,
  summarizeUsage,
  turnMessageCount,
  stringifyPartValue,
  unavailableTranscriptLabel,
  visualStatusForSession,
} from "../format";
import { cn } from "../styles";
import type {
  ConversationTurn,
  TranscriptMessage,
  TranscriptPart,
} from "../types";
import { StatusBadge } from "./StatusBadge";
import { ToolFrame, toolFrameClass } from "./ToolFrame";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
  TranscriptThoughtLabel,
} from "./TranscriptHeadingRow";
import { MetricList, type MetricListItem } from "./Metric";
import {
  DurationMetric,
  MessagesMetric,
  TokenMetric,
  ToolCallsMetric,
} from "./TelemetryMetrics";
import { TranscriptText } from "./TranscriptText";
import { TranscriptThinkingView } from "./TranscriptThinkingView";
import { TranscriptToolRun } from "./TranscriptToolRun";
import { TranscriptToolView } from "./TranscriptToolView";
import {
  countRenderedTranscriptChildren,
  groupTranscriptMessages,
  groupTranscriptParts,
  messageRawText,
  type RenderedTranscriptPart,
  type TranscriptViewMode,
} from "./transcriptRenderModel";
import {
  transcriptEmptyClass,
  mutedTranscriptMetaClass,
} from "./transcriptStyles";
import { previewToolValue } from "./transcriptPreview";

type TranscriptEntry = ReturnType<typeof groupTranscriptMessages>[number];
type TranscriptMessageEntry = Extract<TranscriptEntry, { kind: "message" }>;
type TranscriptThinkingEntry = Extract<TranscriptEntry, { kind: "thinking" }>;
type TranscriptToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** Render one conversation turn as actor messages and tool events. */
export function TurnTranscript(props: {
  number: number;
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
        <TurnHeader number={props.number} turn={props.turn} />
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

function transcriptRoleLabel(role: string, turn: ConversationTurn): string {
  const kind = transcriptRoleKind(role);
  if (kind === "assistant") return "Junior";
  if (kind === "user") return turnActorLabel(turn);
  if (kind === "system") return "System";
  if (kind === "tool") return "Tool";
  return role;
}

function transcriptMessageClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-l-4 py-2 pl-3",
    kind === "assistant" &&
      "border-l-violet-300 bg-[rgba(190,170,255,0.14)] pr-3 text-white",
    kind === "user" && "border-l-white/70 bg-white/[0.08] pr-3 text-[#f4f4f4]",
    kind === "system" &&
      "border-l-amber-300 bg-amber-300/[0.06] pr-3 text-[#f4f4f4]",
    kind === "tool" && "border-l-[#888] text-[#b8b8b8]",
    kind === "other" && "border-l-white/35 text-[#f4f4f4]",
  );
}

function transcriptRoleClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "text-[0.88rem] leading-snug",
    kind === "assistant" && "text-[#d8ccff]",
    kind === "user" && "text-white",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-[#b8b8b8]",
    kind === "other" && "text-[#f4f4f4]",
  );
}

function transcriptRoleLabelClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "inline-block max-w-full break-all text-[0.98rem] font-extrabold leading-tight",
    kind === "assistant" && "text-violet-200",
    kind === "user" && "text-white",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-[#b8b8b8]",
    kind === "other" && "text-white",
  );
}

function TranscriptMessageShell(props: {
  children: ReactNode;
  onCopy?: ClipboardEventHandler<HTMLElement>;
  role: string;
}) {
  return (
    <article
      className={transcriptMessageClass(props.role)}
      onCopy={props.onCopy}
    >
      {props.children}
    </article>
  );
}

function TranscriptMessageHeader(props: {
  meta?: Array<string | undefined>;
  role: string;
  turn: ConversationTurn;
}) {
  const metaText = props.meta?.filter(isString).join(" · ");

  return (
    <TranscriptHeadingRow
      left={
        <span className={transcriptRoleLabelClass(props.role)}>
          {transcriptRoleLabel(props.role, props.turn)}
        </span>
      }
      leftClassName={transcriptRoleClass(props.role)}
      right={
        metaText ? (
          <TranscriptHeadingMeta className="text-[0.78rem] text-[#888]">
            {metaText}
          </TranscriptHeadingMeta>
        ) : undefined
      }
    />
  );
}

function TurnHeader(props: { number: number; turn: ConversationTurn }) {
  const status = visualStatusForSession(props.turn);

  return (
    <div className="flex items-start justify-between gap-3 max-md:flex-col">
      <div className="min-w-0">
        <div className="break-all text-[1.05rem] font-bold leading-tight tracking-normal">
          Turn {props.number}
        </div>
        <MetricList
          className={cn(mutedTranscriptMetaClass(), "mt-1")}
          items={turnMeta(props.turn)}
        />
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
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pt-3">
      {props.turn.transcriptAvailable ? (
        <TranscriptEntryList
          entries={groupTranscriptMessages(props.turn.transcript)}
          keyPrefix={props.turn.id}
          renderMessage={(entry, index) => (
            <TranscriptMessageView
              key={`${props.turn.id}:${index}`}
              message={entry.message}
              turn={props.turn}
              view={props.view}
            />
          )}
          renderThinking={(entry, index) => (
            <TranscriptThinkingView
              key={`${props.turn.id}:thinking:${index}`}
              timestamp={entry.timestamp}
              value={entry.part.output}
            />
          )}
          renderTool={(entry, index) => (
            <TranscriptToolView
              call={entry.call}
              key={`${props.turn.id}:${index}`}
              result={entry.result}
              resultTimestamp={entry.resultTimestamp}
              timestamp={entry.timestamp}
              view={props.view}
            />
          )}
        />
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

function TranscriptEntryList(props: {
  entries: TranscriptEntry[];
  keyPrefix: string;
  renderMessage: (entry: TranscriptMessageEntry, index: number) => ReactNode;
  renderThinking: (entry: TranscriptThinkingEntry, index: number) => ReactNode;
  renderTool: (entry: TranscriptToolEntry, index: number) => ReactNode;
}) {
  const rows: ReactNode[] = [];

  for (let index = 0; index < props.entries.length; ) {
    const entry = props.entries[index]!;

    if (entry.kind === "tool") {
      const startIndex = index;
      const tools: TranscriptToolEntry[] = [];
      while (props.entries[index]?.kind === "tool") {
        tools.push(props.entries[index] as TranscriptToolEntry);
        index += 1;
      }
      rows.push(
        <TranscriptToolRun
          entries={tools}
          key={`${props.keyPrefix}:tool-run:${startIndex}`}
          keyPrefix={props.keyPrefix}
          renderTool={props.renderTool}
          startIndex={startIndex}
        />,
      );
      continue;
    }

    rows.push(
      <Fragment key={`${props.keyPrefix}:${entry.kind}:${index}`}>
        {entry.kind === "thinking"
          ? props.renderThinking(entry, index)
          : props.renderMessage(entry, index)}
      </Fragment>,
    );
    index += 1;
  }

  return <>{rows}</>;
}

function RedactedTranscriptView(props: { turn: ConversationTurn }) {
  return (
    <TranscriptEntryList
      entries={groupTranscriptMessages(props.turn.transcriptMetadata ?? [])}
      keyPrefix={`${props.turn.id}:redacted`}
      renderMessage={(entry, index) => (
        <RedactedMessageView
          key={`${props.turn.id}:redacted:${index}`}
          message={entry.message}
          turn={props.turn}
        />
      )}
      renderThinking={(entry, index) => (
        <RedactedThinkingView
          key={`${props.turn.id}:redacted:thinking:${index}`}
          timestamp={entry.timestamp}
        />
      )}
      renderTool={(entry, index) => (
        <RedactedToolView
          call={entry.call}
          key={`${props.turn.id}:redacted:${index}`}
          result={entry.result}
          resultTimestamp={entry.resultTimestamp}
          timestamp={entry.timestamp}
        />
      )}
    />
  );
}

function RedactedMessageView(props: {
  message: TranscriptMessage;
  turn: ConversationTurn;
}) {
  const meta = [formatMessageTimestamp(props.message.timestamp)].filter(
    isString,
  );

  return (
    <TranscriptMessageShell role={props.message.role}>
      <TranscriptMessageHeader
        meta={meta}
        role={props.message.role}
        turn={props.turn}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 font-mono text-[0.9rem] leading-snug text-[#b8b8b8]">
        {props.message.parts.map((part, index) => (
          <RedactedPartLine key={index} part={part} />
        ))}
      </div>
    </TranscriptMessageShell>
  );
}

function RedactedPartLine(props: { part: TranscriptPart }) {
  if (props.part.type === "text") {
    return <RedactedMetadataRow meta={redactedMessageSize(props.part)} />;
  }
  if (props.part.type === "thinking") {
    return <RedactedMetadataRow />;
  }
  return <RedactedMetadataRow />;
}

function RedactedMetadataRow(props: { meta?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1 max-md:grid-cols-1">
      <RedactedMarker />
      {props.meta ? (
        <span className="min-w-0 break-words text-right text-[#888] max-md:text-left">
          {props.meta}
        </span>
      ) : null}
    </div>
  );
}

function RedactedMarker() {
  return (
    <code className="inline-flex w-fit font-mono text-[0.82rem] leading-tight text-[#b8b8b8]">
      {"<redacted>"}
    </code>
  );
}

function RedactedThinkingView(props: { timestamp?: number }) {
  const meta = [
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);
  const metaText = meta.join(" · ");

  return (
    <div className="py-1.5 text-[0.84rem] leading-relaxed text-[#888]">
      <TranscriptHeadingRow
        left={
          <>
            <TranscriptThoughtLabel />
            <RedactedMarker />
          </>
        }
        leftClassName="gap-3"
        right={
          metaText ? (
            <TranscriptHeadingMeta className="text-[0.78rem] text-[#777]">
              {metaText}
            </TranscriptHeadingMeta>
          ) : undefined
        }
      />
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
    duration,
    props.result ? undefined : "missing result",
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);
  const mobileSummaryMeta =
    duration ?? (props.call && !props.result ? "missing result" : undefined);

  return (
    <ToolFrame
      meta={meta}
      mobileSummaryMeta={mobileSummaryMeta}
      raw
      signature={
        <>
          <strong className="min-w-0 break-words font-bold text-[#d6d6d6]">
            {toolName}
          </strong>
          {props.call?.inputKeys?.length ? (
            <code className="min-w-0 break-words font-[inherit] text-[#b8b8b8] max-md:hidden">
              ({props.call.inputKeys.join(", ")})
            </code>
          ) : null}
        </>
      }
    />
  );
}

function redactedMessageSize(part: TranscriptPart): string | undefined {
  if (typeof part.bytes === "number") return formatBytes(part.bytes);
  return typeof part.chars === "number" ? `${part.chars} chars` : undefined;
}

function turnActorLabel(turn: ConversationTurn): string {
  return requesterLabel(turn.requesterIdentity) ?? "User";
}

function turnMessageSummary(turn: ConversationTurn) {
  const summary = summarizeMessages([turn]);
  if (summary.total > 0) return summary;
  const total = turnMessageCount(turn);
  return total > 0 ? { items: [], total } : undefined;
}

function turnMeta(turn: ConversationTurn): MetricListItem[] {
  const duration = formatTurnDuration(turn);
  const tokenSummary = summarizeUsage([turn.cumulativeUsage]);
  const toolSummary = summarizeToolCalls([turn]);
  const messageSummary = turnMessageSummary(turn);
  const items: Array<MetricListItem | undefined> = [
    duration !== "none"
      ? {
          content: (
            <DurationMetric
              endedAt={turn.completedAt ?? turn.lastSeenAt}
              label={duration}
              startedAt={turn.startedAt}
            />
          ),
          key: "duration",
        }
      : undefined,
    tokenSummary
      ? {
          content: <TokenMetric summary={tokenSummary} />,
          key: "tokens",
        }
      : undefined,
    messageSummary
      ? {
          content: <MessagesMetric summary={messageSummary} />,
          key: "messages",
        }
      : undefined,
    toolSummary.total > 0
      ? {
          content: <ToolCallsMetric summary={toolSummary} />,
          key: "tools",
        }
      : undefined,
    turn.sentryTraceUrl
      ? {
          content: (
            <a
              className="text-white no-underline hover:underline"
              href={turn.sentryTraceUrl}
              rel="noreferrer"
              target="_blank"
            >
              View in Sentry
            </a>
          ),
          key: "sentry",
        }
      : undefined,
  ];

  return items.filter((item): item is MetricListItem => Boolean(item));
}

/**
 * Render the system prompt as a collapsed disclosure. Uses the same
 * groupTranscriptParts → TranscriptPartView → TranscriptText pipeline as every
 * other message so XML tag collapsing, syntax highlighting, and copy behaviour
 * stay consistent. detectLanguage returns "xml" for the system prompt once the
 * block-level XML heuristic in format.ts fires.
 */
function SystemMessageView(props: {
  message: TranscriptMessage;
  turn: ConversationTurn;
  view: TranscriptViewMode;
}) {
  const [open, setOpen] = useState(false);
  const rawText = messageRawText(props.message);
  const role = props.message.role;
  const byteCount = new TextEncoder().encode(rawText).byteLength;
  const renderedParts = groupTranscriptParts(props.message.parts);
  const totalRenderedChildren = renderedParts.reduce(
    (count, part) => count + countRenderedTranscriptChildren(part, role),
    0,
  );
  let seenRenderedChildren = 0;

  return (
    <details
      className={cn(transcriptMessageClass(role), !open && "gap-y-0")}
      onToggle={(event) => {
        if (event.currentTarget !== event.target) return;
        setOpen(event.currentTarget.open);
      }}
      open={open}
    >
      <summary className="block min-h-6 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <TranscriptMessageHeader
          meta={[formatBytes(byteCount)]}
          role={role}
          turn={props.turn}
        />
      </summary>
      {props.view === "raw" ? (
        <HighlightedCode
          code={rawText || "{}"}
          language={detectLanguage(rawText)}
        />
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {renderedParts.map((part, index) => {
            const firstChildIndex = seenRenderedChildren;
            seenRenderedChildren += countRenderedTranscriptChildren(part, role);
            return (
              <TranscriptPartView
                firstChildIndex={firstChildIndex}
                key={index}
                lastChildIndex={totalRenderedChildren - 1}
                part={part}
                role={role}
              />
            );
          })}
        </div>
      )}
    </details>
  );
}

function TranscriptMessageView(props: {
  message: TranscriptMessage;
  turn: ConversationTurn;
  view: TranscriptViewMode;
}) {
  if (transcriptRoleKind(props.message.role) === "system") {
    return (
      <SystemMessageView
        message={props.message}
        turn={props.turn}
        view={props.view}
      />
    );
  }

  const renderedParts = groupTranscriptParts(props.message.parts);
  const rawText = messageRawText(props.message);
  const role = props.message.role;
  const totalRenderedChildren = renderedParts.reduce(
    (count, part) => count + countRenderedTranscriptChildren(part, role),
    0,
  );
  let seenRenderedChildren = 0;

  return (
    <TranscriptMessageShell
      role={props.message.role}
      onCopy={(event) => {
        if (props.view !== "rich" || !rawText) return;
        event.clipboardData.setData("text/plain", rawText);
        event.preventDefault();
      }}
    >
      <TranscriptMessageHeader
        meta={[formatMessageTimestamp(props.message.timestamp)]}
        role={props.message.role}
        turn={props.turn}
      />
      {props.view === "raw" ? (
        <HighlightedCode
          code={rawText || "{}"}
          language={detectLanguage(rawText)}
        />
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {renderedParts.map((part, index) => {
            const firstChildIndex = seenRenderedChildren;
            seenRenderedChildren += countRenderedTranscriptChildren(part, role);
            return (
              <TranscriptPartView
                firstChildIndex={firstChildIndex}
                key={index}
                lastChildIndex={totalRenderedChildren - 1}
                part={part}
                role={role}
              />
            );
          })}
        </div>
      )}
    </TranscriptMessageShell>
  );
}

function TranscriptPartView(props: {
  firstChildIndex: number;
  lastChildIndex: number;
  part: RenderedTranscriptPart;
  role?: string;
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
        role={props.role}
        text={part.text ?? ""}
      />
    );
  }

  const value = part.output;
  if (part.type === "thinking") {
    return <TranscriptThinkingView value={value} />;
  }

  const rendered = stringifyPartValue(value);
  return (
    <details className={toolFrameClass()}>
      <summary className="block cursor-pointer list-none py-1.5 font-mono text-[0.82rem] leading-tight text-[#b8b8b8] transition-colors hover:text-[#d6d6d6] [&::-webkit-details-marker]:hidden">
        <TranscriptHeadingRow
          left={
            <>
              <span className="text-[#888] max-md:hidden">{part.type}</span>
              <strong className="min-w-0 break-words font-bold text-[#d6d6d6]">
                {part.name ?? part.id ?? "unknown"}
              </strong>
            </>
          }
          leftClassName="gap-3"
          right={
            <span className="min-w-0 break-words text-right max-md:hidden">
              {previewToolValue(value)}
            </span>
          }
          rightClassName="min-w-0 max-md:hidden"
        />
      </summary>
      <HighlightedCode code={rendered || "{}"} language="json" />
    </details>
  );
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
