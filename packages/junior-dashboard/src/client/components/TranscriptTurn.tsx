import type { ClipboardEventHandler, ReactNode } from "react";

import { HighlightedCode } from "../code";
import {
  detectLanguage,
  formatBytes,
  formatMessageOffset,
  formatMessageTimestamp,
  formatMs,
  formatUsage,
  requesterLabel,
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
import { TranscriptText } from "./TranscriptText";
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

type TranscriptRoleKind = "assistant" | "other" | "system" | "tool" | "user";

function transcriptRoleKind(role: string): TranscriptRoleKind {
  const normalized = role.toLowerCase();
  if (normalized === "assistant") return "assistant";
  if (normalized === "user") return "user";
  if (normalized === "system") return "system";
  if (normalized.includes("tool")) return "tool";
  return "other";
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
    "grid min-w-0 gap-2 border-l-4 py-2 pl-3",
    kind === "assistant" &&
      "border-l-violet-300 bg-[rgba(190,170,255,0.08)] pr-3 text-white",
    kind === "user" && "border-l-white/70 bg-white/[0.04] pr-3 text-[#f4f4f4]",
    kind === "system" &&
      "border-l-amber-300 bg-amber-300/[0.06] pr-3 text-[#f4f4f4]",
    kind === "tool" && "border-l-[#888] text-[#b8b8b8]",
    kind === "other" && "border-l-white/35 text-[#f4f4f4]",
  );
}

function transcriptRoleClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "flex flex-wrap items-baseline gap-2 text-[0.88rem] leading-snug",
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

function TurnHeader(props: { number: number; turn: ConversationTurn }) {
  const status = visualStatusForSession(props.turn);

  return (
    <div className="flex items-start justify-between gap-3 max-md:flex-col">
      <div className="min-w-0">
        <div className="break-all text-[1.05rem] font-bold leading-tight tracking-normal">
          Turn {props.number}
        </div>
        <div className={cn(mutedTranscriptMetaClass(), "mt-1")}>
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
  const meta = [formatMessageTimestamp(props.message.timestamp), offset].filter(
    isString,
  );

  return (
    <TranscriptMessageShell role={props.message.role}>
      <div className={transcriptRoleClass(props.message.role)}>
        <span className={transcriptRoleLabelClass(props.message.role)}>
          {transcriptRoleLabel(props.message.role, props.turn)}
        </span>
        {meta.map((value, index) => (
          <span
            className="font-mono text-[0.78rem] text-[#888]"
            key={`${index}-${value}`}
          >
            {value}
          </span>
        ))}
      </div>
      <div className="grid min-w-0 gap-1 font-mono text-[0.9rem] leading-snug text-[#b8b8b8]">
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

function redactedMessageSize(part: TranscriptPart): string | undefined {
  if (typeof part.bytes === "number") return formatBytes(part.bytes);
  return typeof part.chars === "number" ? `${part.chars} chars` : undefined;
}

function turnActorLabel(turn: ConversationTurn): string {
  return (
    requesterLabel(turn.requesterIdentity, turn.requester) ?? "unknown actor"
  );
}

function turnMeta(turn: ConversationTurn): string[] {
  return [
    formatMs(turn.cumulativeDurationMs),
    formatUsage(turn.cumulativeUsage),
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
    <TranscriptMessageShell
      role={props.message.role}
      onCopy={(event) => {
        if (props.view !== "rich" || !rawText) return;
        event.clipboardData.setData("text/plain", rawText);
        event.preventDefault();
      }}
    >
      <div className={transcriptRoleClass(props.message.role)}>
        <span className={transcriptRoleLabelClass(props.message.role)}>
          {transcriptRoleLabel(props.message.role, props.turn)}
        </span>
        <span className="font-mono text-[0.78rem] text-[#888]">
          {formatMessageTimestamp(props.message.timestamp)}
        </span>
        {offset ? (
          <span className="font-mono text-[0.78rem] text-[#888]">{offset}</span>
        ) : null}
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
    </TranscriptMessageShell>
  );
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

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
