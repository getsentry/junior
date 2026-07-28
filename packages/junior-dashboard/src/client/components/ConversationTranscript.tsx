import { Fragment, type ClipboardEventHandler, type ReactNode } from "react";
import {
  Bot,
  CircleAlert,
  Diff,
  Minimize2,
  Send,
  type LucideIcon,
} from "lucide-react";

import { countStructuredBlockChildren, HighlightedCode } from "../code";
import {
  detectLanguage,
  transcriptRoleKind,
  formatMessageTimestamp,
  formatTranscriptDuration,
  actorLabel,
  parseMarkdownBlocks,
  summarizeCost,
  summarizeTurns,
  summarizeToolCalls,
  summarizeUsage,
  unavailableTranscriptLabel,
  visualStatusForSummary,
} from "../format";
import { cn } from "../styles";
import { conversationTranscriptMessages } from "../conversations/eventTranscript";
import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewSubagentPart,
} from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
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
import { TranscriptSubagentView } from "./TranscriptSubagentView";
import { TranscriptContextEventView } from "./TranscriptContextEventView";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";
import { TranscriptToolRun } from "./TranscriptToolRun";
import { TranscriptToolView } from "./TranscriptToolView";
import { shouldCopyRawTranscript } from "./transcriptCopy";
import {
  groupTranscriptMessages,
  messageRawText,
  type RenderedToolEntry,
  type TranscriptViewMode,
} from "./transcriptRenderModel";
import {
  transcriptEmptyClass,
  mutedTranscriptMetaClass,
} from "./transcriptStyles";
import {
  entryMatchesSearch,
  HighlightText,
  useTranscriptSearch,
} from "./transcriptSearch";

type TranscriptEntry = ReturnType<typeof groupTranscriptMessages>[number];
type TranscriptContextEntry = Extract<TranscriptEntry, { kind: "context" }>;
type TranscriptFailureEntry = Extract<TranscriptEntry, { kind: "failure" }>;
type TranscriptMessageEntry = Extract<TranscriptEntry, { kind: "message" }>;
type TranscriptSubagentEntry = Extract<TranscriptEntry, { kind: "subagent" }>;
type TranscriptToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** Render one conversation transcript segment as actor messages and tool events. */
export function ConversationTranscriptView(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
  responding?: boolean;
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
        {props.responding ? <TypingIndicator /> : null}
      </div>
    </section>
  );
}

function TypingIndicator() {
  return (
    <div aria-live="polite" className="mt-2 flex items-center" role="status">
      <span className="sr-only">Junior is responding</span>
      <span className="flex items-center gap-1 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.055] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
        {[0, 1, 2].map((dot) => (
          <span
            aria-hidden="true"
            className="size-1.5 animate-bounce rounded-full bg-cyan-100/70 motion-reduce:animate-none"
            key={dot}
            style={{ animationDelay: `${dot * 150}ms` }}
          />
        ))}
      </span>
    </div>
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
  return (
    <div className="min-w-0">
      <MetricList
        className={mutedTranscriptMetaClass()}
        items={transcriptMeta(props.conversation)}
      />
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
      {props.conversation.eventHistory.status === "available" ? (
        <VisibleTranscriptEntries
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={messages}
          conversation={props.conversation}
          view={props.view}
        />
      ) : props.conversation.eventHistory.status === "redacted" &&
        messages.length > 0 ? (
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
      renderContext={(entry) => (
        <TranscriptRailEvent
          kind={entry.part.event.type === "handoff" ? "handoff" : "compaction"}
        >
          <TranscriptContextEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderFailure={(entry) => (
        <TranscriptFailureView
          outcome={entry.outcome}
          timestamp={entry.timestamp}
        />
      )}
      renderMessage={(entry) =>
        entry.message.eventType ? (
          <TranscriptRailEvent kind="resource_event">
            <TranscriptResourceEventView message={entry.message} />
          </TranscriptRailEvent>
        ) : (
          <TranscriptMessageView
            message={entry.message}
            conversation={props.conversation}
            view={props.view}
          />
        )
      }
      renderSubagent={(entry) => (
        <TranscriptRailEvent kind="subagent">
          <TranscriptSubagentView
            onOpenTranscript={(part: TranscriptViewSubagentPart) =>
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
      renderTool={(entry) => (
        <TranscriptToolView
          part={entry.part}
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
  renderContext: (entry: TranscriptContextEntry) => ReactNode;
  renderFailure: (entry: TranscriptFailureEntry) => ReactNode;
  renderMessage: (entry: TranscriptMessageEntry) => ReactNode;
  renderSubagent: (entry: TranscriptSubagentEntry) => ReactNode;
  renderTool: (entry: TranscriptToolEntry) => ReactNode;
}) {
  const search = useTranscriptSearch();
  const rows: ReactNode[] = [];

  for (let index = 0; index < props.entries.length; ) {
    const entry = props.entries[index]!;

    if (entry.kind === "tool") {
      const runEntries: RenderedToolEntry[] = [];
      while (props.entries[index]?.kind === "tool") {
        runEntries.push(props.entries[index] as RenderedToolEntry);
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
            key={`${props.keyPrefix}:tool-run:${runEntries.at(-1)!.key}`}
            renderTool={props.renderTool}
          />,
        );
      }
      continue;
    }

    if (!search.active || entryMatchesSearch(entry, search.normalizedQuery)) {
      rows.push(
        <Fragment key={`${props.keyPrefix}:${entry.key}`}>
          {entry.kind === "subagent"
            ? props.renderSubagent(entry)
            : entry.kind === "context"
              ? props.renderContext(entry)
              : entry.kind === "failure"
                ? props.renderFailure(entry)
                : props.renderMessage(entry)}
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

function TranscriptFailureView(props: {
  outcome: "error" | "delivery_failed";
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  const deliveryFailed = props.outcome === "delivery_failed";

  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-lg border border-rose-300/25 bg-rose-300/[0.07] px-4 py-3 text-rose-100 max-md:grid-cols-[auto_minmax(0,1fr)]"
      data-transcript-failure={props.outcome}
      role="alert"
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 text-rose-300"
        size={16}
      />
      <div className="min-w-0">
        <div className="font-display text-[0.95rem] font-semibold leading-tight">
          {deliveryFailed ? "Message delivery failed" : "Agent response failed"}
        </div>
        <div className="mt-1 text-[0.84rem] leading-relaxed text-rose-100/70">
          {deliveryFailed
            ? "Junior could not deliver this message to its destination."
            : "The model response ended before Junior could complete this turn."}
        </div>
      </div>
      {timestamp ? (
        <span className="font-mono text-[0.78rem] leading-none text-rose-100/55 max-md:col-start-2">
          {timestamp}
        </span>
      ) : null}
    </div>
  );
}

type TranscriptRailEventKind =
  | "compaction"
  | "handoff"
  | "resource_event"
  | "subagent";

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
          "absolute -left-[1.95rem] z-[1] grid size-6 place-items-center rounded border bg-[#071012] shadow-[0_0_0_3px_#050507,0_8px_20px_rgba(0,0,0,0.3)]",
          props.kind === "resource_event" ? "top-2" : "top-1",
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
  if (kind === "resource_event") {
    return {
      className: "border-violet-300/35 text-violet-200",
      icon: Diff,
    };
  }
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
      renderContext={(entry) => (
        <TranscriptRailEvent
          kind={entry.part.event.type === "handoff" ? "handoff" : "compaction"}
        >
          <TranscriptContextEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderFailure={(entry) => (
        <TranscriptFailureView
          outcome={entry.outcome}
          timestamp={entry.timestamp}
        />
      )}
      renderMessage={(entry) =>
        entry.message.eventType ? (
          <TranscriptRailEvent kind="resource_event">
            <TranscriptResourceEventView message={entry.message} />
          </TranscriptRailEvent>
        ) : (
          <RedactedMessageView
            message={entry.message}
            conversation={props.conversation}
          />
        )
      }
      renderSubagent={(entry) => (
        <TranscriptRailEvent kind="subagent">
          <TranscriptSubagentView
            onOpenTranscript={(part: TranscriptViewSubagentPart) =>
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
      renderTool={(entry) => (
        <TranscriptToolView part={entry.part} timestamp={entry.timestamp} />
      )}
    />
  );
}

function RedactedMessageView(props: {
  message: TranscriptMessageEntry["message"];
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
        {props.message.parts.map((_part, index) => (
          <RedactedMetadataRow key={index} />
        ))}
      </div>
    </TranscriptMessageShell>
  );
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

function transcriptActorLabel(conversation: ConversationTranscript): string {
  return actorLabel(conversation.actorIdentity) ?? "User";
}

function transcriptMeta(
  conversation: ConversationTranscript,
): MetricListItem[] {
  const duration = formatTranscriptDuration(conversation);
  const tokenSummary = summarizeUsage(conversation.cumulativeUsage);
  const costSummary = summarizeCost(conversation.cumulativeUsage);
  const completeHistory = !conversation.previousCursor;
  const toolSummary = completeHistory
    ? summarizeToolCalls(conversation)
    : undefined;
  const turnSummary = completeHistory
    ? summarizeTurns(conversation)
    : undefined;
  const items: Array<MetricListItem | undefined> = [
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
          content: (
            <TokenMetric
              compactionCount={
                completeHistory
                  ? conversation.events.filter(
                      (event) => event.data.type === "compaction",
                    ).length
                  : undefined
              }
              modelUsage={conversation.modelUsage}
              summary={tokenSummary}
            />
          ),
          key: "tokens",
        }
      : undefined,
    costSummary
      ? {
          content: (
            <CostMetric
              modelUsage={conversation.modelUsage}
              summary={costSummary}
            />
          ),
          key: "cost",
        }
      : undefined,
    turnSummary
      ? {
          content: <TurnsMetric summary={turnSummary} />,
          key: "turns",
        }
      : undefined,
    toolSummary && toolSummary.total > 0
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

function TranscriptResourceEventView(props: {
  message: TranscriptMessageEntry["message"];
}) {
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  return (
    <details className="min-w-0 rounded-lg border border-violet-300/10 bg-violet-300/[0.035] px-3 py-2">
      <summary className="cursor-pointer list-none font-display text-[0.88rem] font-semibold text-violet-100 [&::-webkit-details-marker]:hidden">
        <HighlightText text={props.message.eventType ?? ""} />
      </summary>
      {text ? (
        <div className="mt-2 whitespace-pre-wrap text-[0.8rem] leading-relaxed text-white/55">
          <HighlightText text={text} />
        </div>
      ) : redacted ? (
        <div className="mt-2">
          <RedactedMarker />
        </div>
      ) : null}
    </details>
  );
}

function TranscriptMessageView(props: {
  message: TranscriptMessageEntry["message"];
  conversation: ConversationTranscript;
  view: TranscriptViewMode;
}) {
  const rawText = messageRawText(props.message);
  const role = props.message.role;
  const totalRenderedChildren = props.message.parts.reduce(
    (count, part) => count + renderedTextChildren(part.text ?? "", role),
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
        meta={[
          props.message.route
            ? `${props.message.route.modelProfile} · ${props.message.route.reasoningLevel} · ${props.message.route.modelId}`
            : undefined,
          formatMessageTimestamp(props.message.timestamp),
        ]}
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
          {props.message.parts.map((part, index) => {
            const firstChildIndex = seenRenderedChildren;
            seenRenderedChildren += renderedTextChildren(part.text ?? "", role);
            return (
              <TranscriptText
                firstChildIndex={firstChildIndex}
                key={index}
                lastChildIndex={totalRenderedChildren - 1}
                role={role}
                text={part.text ?? ""}
              />
            );
          })}
        </div>
      )}
      {props.view === "rich" &&
      props.message.role === "user" &&
      props.message.contexts?.length ? (
        <TranscriptTurnContextView contexts={props.message.contexts} />
      ) : null}
    </TranscriptMessageShell>
  );
}

function renderedTextChildren(text: string, role: string): number {
  return parseMarkdownBlocks(text, {
    outputOnly: transcriptRoleKind(role) === "assistant",
  }).reduce((count, block) => count + countStructuredBlockChildren(block), 0);
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
