import {
  Fragment,
  useState,
  type ClipboardEventHandler,
  type ReactNode,
} from "react";
import { Bot, Minimize2, Send, type LucideIcon } from "lucide-react";

import { HighlightedCode } from "../code";
import {
  detectLanguage,
  transcriptRoleKind,
  formatBytes,
  formatMessageTimestamp,
  formatMs,
  formatTranscriptDuration,
  actorLabel,
  summarizeCost,
  summarizeTurns,
  summarizeToolCalls,
  summarizeUsage,
  stringifyPartValue,
  unavailableTranscriptLabel,
  visualStatusForSummary,
} from "../format";
import { cn } from "../styles";
import { conversationTranscriptMessages } from "../transcriptActivity";
import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewPart,
  TranscriptViewSubagentPart,
} from "../types";
import { ExecutionSignature } from "./ExecutionSignature";
import { StatusBadge } from "./StatusBadge";
import { ToolFrame, toolFrameClass } from "./ToolFrame";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
  TranscriptThoughtLabel,
} from "./TranscriptHeadingRow";
import { MetricList, type MetricListItem } from "./Metric";
import {
  CostMetric,
  DurationMetric,
  TurnsMetric,
  TokenMetric,
  ToolCallsMetric,
} from "./TelemetryMetrics";
import { TranscriptText } from "./TranscriptText";
import { TranscriptThinkingView } from "./TranscriptThinkingView";
import { TranscriptSubagentView } from "./TranscriptSubagentView";
import { TranscriptContextEventView } from "./TranscriptContextEventView";
import { TranscriptToolRun } from "./TranscriptToolRun";
import { TranscriptToolView } from "./TranscriptToolView";
import { shouldCopyRawTranscript } from "./transcriptCopy";
import {
  countRenderedTranscriptChildren,
  groupTranscriptMessages,
  groupTranscriptParts,
  messageRawText,
  type RenderedToolRunEntry,
  type RenderedTranscriptPart,
  type TranscriptViewMode,
} from "./transcriptRenderModel";
import {
  transcriptEmptyClass,
  mutedTranscriptMetaClass,
} from "./transcriptStyles";
import { previewToolValue } from "./transcriptPreview";
import { entryMatchesSearch, useTranscriptSearch } from "./transcriptSearch";

type TranscriptEntry = ReturnType<typeof groupTranscriptMessages>[number];
type TranscriptContextEntry = Extract<TranscriptEntry, { kind: "context" }>;
type TranscriptMessageEntry = Extract<TranscriptEntry, { kind: "message" }>;
type TranscriptSubagentEntry = Extract<TranscriptEntry, { kind: "subagent" }>;
type TranscriptThinkingEntry = Extract<TranscriptEntry, { kind: "thinking" }>;
type TranscriptToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** Render one conversation transcript segment as actor messages and tool events. */
export function ConversationTranscriptView(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
  view: TranscriptViewMode;
}) {
  const status = visualStatusForSummary(props.conversation);

  return (
    <section className="grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)] gap-3 py-3">
      <div className="flex flex-col items-center pt-1.5" aria-hidden="true">
        <span className={turnMarkerClass(status)} />
        <span className="mt-2 w-px flex-1 bg-cyan-300/15" />
      </div>
      <div className="min-w-0">
        <SegmentHeader conversation={props.conversation} />
        <SegmentEvents
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.conversation}
          view={props.view}
        />
      </div>
    </section>
  );
}

function turnMarkerClass(
  status: ReturnType<typeof visualStatusForSummary>,
): string {
  return cn(
    "size-2.5 shrink-0 rounded-full border",
    status === "active" && "border-emerald-300 bg-emerald-300",
    status === "failed" && "border-rose-300 bg-rose-300",
    status === "idle" && "border-cyan-300/60 bg-cyan-300/40",
  );
}

function transcriptRoleLabel(
  role: string,
  conversation: ConversationTranscript,
): string {
  const kind = transcriptRoleKind(role);
  if (kind === "assistant") return conversation.assistantLabel ?? "Junior";
  if (kind === "user") return transcriptActorLabel(conversation);
  if (kind === "system") return "System";
  if (kind === "tool") return "Tool";
  return role;
}

function transcriptMessageClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.12)]",
    kind === "assistant" &&
      "mr-6 border-cyan-300/15 bg-cyan-300/[0.055] text-white",
    kind === "user" &&
      "ml-6 border-white/[0.09] bg-white/[0.055] text-[#f4f4f4]",
    kind === "system" &&
      "border-amber-300/15 bg-amber-300/[0.045] text-[#f4f4f4]",
    kind === "tool" &&
      "border-white/[0.06] bg-black/15 text-[#b8b8b8] shadow-none",
    kind === "other" && "border-white/[0.08] bg-white/[0.03] text-[#f4f4f4]",
  );
}

function transcriptRoleClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "text-[0.88rem] leading-snug",
    kind === "assistant" && "text-cyan-100/75",
    kind === "user" && "text-white",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-[#b8b8b8]",
    kind === "other" && "text-[#f4f4f4]",
  );
}

function transcriptRoleLabelClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "inline-block max-w-full break-all font-display text-[0.95rem] font-semibold leading-tight",
    kind === "assistant" && "text-cyan-100",
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
  conversation: ConversationTranscript;
}) {
  const metaText = props.meta?.filter(isString).join(" · ");

  return (
    <TranscriptHeadingRow
      left={
        <span className={transcriptRoleLabelClass(props.role)}>
          {transcriptRoleLabel(props.role, props.conversation)}
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

function SegmentHeader(props: { conversation: ConversationTranscript }) {
  const status = visualStatusForSummary(props.conversation);

  return (
    <div className="flex items-start justify-between gap-3 max-md:flex-col">
      <div className="min-w-0">
        <MetricList
          className={mutedTranscriptMetaClass()}
          items={transcriptMeta(props.conversation)}
        />
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function SegmentEvents(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
  view: TranscriptViewMode;
}) {
  const messages = conversationTranscriptMessages(props.conversation);

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pt-3">
      {props.conversation.transcriptAvailable ? (
        <VisibleTranscriptEntries
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={messages}
          conversation={props.conversation}
          view={props.view}
        />
      ) : props.conversation.transcriptRedacted && messages.length > 0 ? (
        <RedactedTranscriptView
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.conversation}
        />
      ) : messages.length > 0 ? (
        <VisibleTranscriptEntries
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={messages}
          conversation={props.conversation}
          view={props.view}
        />
      ) : (
        <div className={transcriptEmptyClass()}>
          {unavailableTranscriptLabel(props.conversation)}
        </div>
      )}
    </div>
  );
}

function VisibleTranscriptEntries(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  transcript: TranscriptViewMessage[];
  conversation: ConversationTranscript;
  view: TranscriptViewMode;
}) {
  return (
    <TranscriptEntryList
      entries={groupTranscriptMessages(props.transcript)}
      keyPrefix={props.conversation.conversationId}
      renderContext={(entry, index) => (
        <TranscriptRailEvent
          key={`${props.conversation.conversationId}:context:${index}`}
          kind={
            entry.part.event.type === "model_handoff" ? "handoff" : "compaction"
          }
        >
          <TranscriptContextEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderMessage={(entry, index) => (
        <TranscriptMessageView
          key={`${props.conversation.conversationId}:${index}`}
          message={entry.message}
          conversation={props.conversation}
          view={props.view}
        />
      )}
      renderSubagent={(entry, index) => (
        <TranscriptRailEvent
          key={`${props.conversation.conversationId}:subagent:${index}`}
          kind="subagent"
        >
          <TranscriptSubagentView
            onOpenTranscript={(part) =>
              props.onOpenSubagentTranscript?.({
                part,
                conversation: props.conversation,
              })
            }
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderThinking={(entry, index) => (
        <TranscriptThinkingView
          key={`${props.conversation.conversationId}:thinking:${index}`}
          timestamp={entry.timestamp}
          value={entry.part.output}
        />
      )}
      renderTool={(entry, index) => (
        <TranscriptToolView
          call={entry.call}
          key={`${props.conversation.conversationId}:${index}`}
          result={entry.result}
          resultTimestamp={entry.resultTimestamp}
          timestamp={entry.timestamp}
          view={props.view}
        />
      )}
    />
  );
}

function TranscriptEntryList(props: {
  entries: TranscriptEntry[];
  keyPrefix: string;
  renderContext: (entry: TranscriptContextEntry, index: number) => ReactNode;
  renderMessage: (entry: TranscriptMessageEntry, index: number) => ReactNode;
  renderSubagent: (entry: TranscriptSubagentEntry, index: number) => ReactNode;
  renderThinking: (entry: TranscriptThinkingEntry, index: number) => ReactNode;
  renderTool: (entry: TranscriptToolEntry, index: number) => ReactNode;
}) {
  const search = useTranscriptSearch();
  const rows: ReactNode[] = [];

  for (let index = 0; index < props.entries.length; ) {
    const entry = props.entries[index]!;

    if (entry.kind === "tool" || entry.kind === "thinking") {
      const startIndex = index;
      const runEntries: RenderedToolRunEntry[] = [];
      while (
        props.entries[index]?.kind === "tool" ||
        props.entries[index]?.kind === "thinking"
      ) {
        runEntries.push(props.entries[index] as RenderedToolRunEntry);
        index += 1;
      }
      const visibleEntries = search.active
        ? runEntries.filter((e) =>
            entryMatchesSearch(e, search.normalizedQuery),
          )
        : runEntries;
      if (visibleEntries.length > 0) {
        rows.push(
          <TranscriptToolRun
            autoCollapse={index < props.entries.length}
            entries={visibleEntries}
            key={`${props.keyPrefix}:tool-run:${startIndex}`}
            keyPrefix={props.keyPrefix}
            renderThinking={props.renderThinking}
            renderTool={props.renderTool}
            startIndex={startIndex}
          />,
        );
      }
      continue;
    }

    if (!search.active || entryMatchesSearch(entry, search.normalizedQuery)) {
      rows.push(
        <Fragment key={`${props.keyPrefix}:${entry.kind}:${index}`}>
          {entry.kind === "subagent"
            ? props.renderSubagent(entry, index)
            : entry.kind === "context"
              ? props.renderContext(entry, index)
              : props.renderMessage(entry, index)}
        </Fragment>,
      );
    }
    index += 1;
  }

  if (search.active && rows.length === 0) {
    return (
      <div className={transcriptEmptyClass()}>No events match your search.</div>
    );
  }

  return <>{rows}</>;
}

type TranscriptRailEventKind = "compaction" | "handoff" | "subagent";

/** Anchor noteworthy transcript events to the same visual rail as turn markers. */
function TranscriptRailEvent(props: {
  children: ReactNode;
  kind: TranscriptRailEventKind;
}) {
  const marker = transcriptRailMarker(props.kind);
  const Icon = marker.icon;

  return (
    <div className="relative min-w-0" data-transcript-rail-event={props.kind}>
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-[1.95rem] top-1 z-[1] grid size-6 place-items-center rounded border bg-[#071012] shadow-[0_0_0_3px_#050507,0_8px_20px_rgba(0,0,0,0.3)]",
          marker.className,
        )}
      >
        <Icon size={12} strokeWidth={2.2} />
      </span>
      {props.children}
    </div>
  );
}

function transcriptRailMarker(kind: TranscriptRailEventKind): {
  className: string;
  icon: LucideIcon;
} {
  if (kind === "subagent") {
    return {
      className: "border-cyan-300/35 text-cyan-200",
      icon: Bot,
    };
  }
  if (kind === "handoff") {
    return {
      className: "border-sky-300/35 text-sky-200",
      icon: Send,
    };
  }
  return {
    className: "border-amber-300/35 text-amber-200",
    icon: Minimize2,
  };
}

function RedactedTranscriptView(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
}) {
  return (
    <TranscriptEntryList
      entries={groupTranscriptMessages(
        conversationTranscriptMessages(props.conversation),
      )}
      keyPrefix={`${props.conversation.conversationId}:redacted`}
      renderContext={(entry, index) => (
        <TranscriptRailEvent
          key={`${props.conversation.conversationId}:redacted:context:${index}`}
          kind={
            entry.part.event.type === "model_handoff" ? "handoff" : "compaction"
          }
        >
          <TranscriptContextEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderMessage={(entry, index) => (
        <RedactedMessageView
          key={`${props.conversation.conversationId}:redacted:${index}`}
          message={entry.message}
          conversation={props.conversation}
        />
      )}
      renderSubagent={(entry, index) => (
        <TranscriptRailEvent
          key={`${props.conversation.conversationId}:redacted:subagent:${index}`}
          kind="subagent"
        >
          <TranscriptSubagentView
            onOpenTranscript={(part) =>
              props.onOpenSubagentTranscript?.({
                part,
                conversation: props.conversation,
              })
            }
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderThinking={(entry, index) => (
        <RedactedThinkingView
          key={`${props.conversation.conversationId}:redacted:thinking:${index}`}
          timestamp={entry.timestamp}
        />
      )}
      renderTool={(entry, index) => (
        <RedactedToolView
          call={entry.call}
          key={`${props.conversation.conversationId}:redacted:${index}`}
          result={entry.result}
          resultTimestamp={entry.resultTimestamp}
          timestamp={entry.timestamp}
        />
      )}
    />
  );
}

function RedactedMessageView(props: {
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
}) {
  const meta = [formatMessageTimestamp(props.message.timestamp)].filter(
    isString,
  );

  return (
    <TranscriptMessageShell role={props.message.role}>
      <TranscriptMessageHeader
        meta={meta}
        role={props.message.role}
        conversation={props.conversation}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 font-mono text-[0.9rem] leading-snug text-[#b8b8b8]">
        {props.message.parts.map((part, index) => (
          <RedactedPartLine key={index} part={part} />
        ))}
      </div>
    </TranscriptMessageShell>
  );
}

function RedactedPartLine(props: { part: TranscriptViewPart }) {
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
  call?: TranscriptViewPart;
  result?: TranscriptViewPart;
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
  const missingResultLabel =
    props.call?.status === "running" ? "running" : "missing result";
  const meta = [
    duration,
    props.result ? undefined : missingResultLabel,
    typeof props.timestamp === "number"
      ? formatMessageTimestamp(props.timestamp)
      : undefined,
  ].filter(isString);
  const mobileSummaryMeta =
    duration ?? (props.call && !props.result ? missingResultLabel : undefined);

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

function redactedMessageSize(part: TranscriptViewPart): string | undefined {
  if (typeof part.bytes === "number") return formatBytes(part.bytes);
  return typeof part.chars === "number" ? `${part.chars} chars` : undefined;
}

function transcriptActorLabel(conversation: ConversationTranscript): string {
  return actorLabel(conversation.actorIdentity) ?? "User";
}

function transcriptMeta(
  conversation: ConversationTranscript,
): MetricListItem[] {
  const duration = formatTranscriptDuration(conversation);
  const tokenSummary = summarizeUsage(conversation.cumulativeUsage);
  const costSummary = summarizeCost(conversation.cumulativeUsage);
  const toolSummary = summarizeToolCalls(conversation);
  const turnSummary = summarizeTurns(conversation);
  const items: Array<MetricListItem | undefined> = [
    conversation.modelId || conversation.reasoningLevel
      ? {
          content: (
            <ExecutionSignature
              className="text-cyan-200"
              modelId={conversation.modelId}
              reasoningLevel={conversation.reasoningLevel}
            />
          ),
          key: "execution",
        }
      : undefined,
    duration !== "none"
      ? {
          content: (
            <DurationMetric
              endedAt={conversation.lastSeenAt}
              label={duration}
              startedAt={conversation.startedAt}
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
    costSummary
      ? {
          content: <CostMetric summary={costSummary} />,
          key: "cost",
        }
      : undefined,
    turnSummary
      ? {
          content: <TurnsMetric summary={turnSummary} />,
          key: "turns",
        }
      : undefined,
    toolSummary.total > 0
      ? {
          content: <ToolCallsMetric summary={toolSummary} />,
          key: "tools",
        }
      : undefined,
    conversation.sentryTraceUrl
      ? {
          content: (
            <a
              className="text-white no-underline hover:underline"
              href={conversation.sentryTraceUrl}
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
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
  view: TranscriptViewMode;
}) {
  const [open, setOpen] = useState(false);
  const { active: searchActive } = useTranscriptSearch();
  const rawText = messageRawText(props.message);
  const role = props.message.role;
  const byteCount = new TextEncoder().encode(rawText).byteLength;
  const renderedParts = groupTranscriptParts(props.message.parts);
  const totalRenderedChildren = renderedParts.reduce(
    (count, part) => count + countRenderedTranscriptChildren(part, role),
    0,
  );
  let seenRenderedChildren = 0;

  // Force-expand the system prompt during search so highlighted matches are visible.
  if (searchActive) {
    return (
      <article className={transcriptMessageClass(role)}>
        <div className="block min-h-6">
          <TranscriptMessageHeader
            meta={[formatBytes(byteCount)]}
            role={role}
            conversation={props.conversation}
          />
        </div>
        {props.view === "raw" ? (
          <HighlightedCode
            code={rawText || "{}"}
            language={detectLanguage(rawText)}
          />
        ) : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
            {renderedParts.map((part, index) => {
              const firstChildIndex = seenRenderedChildren;
              seenRenderedChildren += countRenderedTranscriptChildren(
                part,
                role,
              );
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
      </article>
    );
  }

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
          conversation={props.conversation}
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
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
  view: TranscriptViewMode;
}) {
  if (transcriptRoleKind(props.message.role) === "system") {
    return (
      <SystemMessageView
        message={props.message}
        conversation={props.conversation}
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
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (
          !shouldCopyRawTranscript(
            props.view,
            rawText,
            selection,
            event.currentTarget,
          )
        ) {
          return;
        }
        event.clipboardData.setData("text/plain", rawText);
        event.preventDefault();
      }}
    >
      <TranscriptMessageHeader
        meta={[formatMessageTimestamp(props.message.timestamp)]}
        role={props.message.role}
        conversation={props.conversation}
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
