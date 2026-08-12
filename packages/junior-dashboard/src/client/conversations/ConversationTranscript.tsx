import {
  Fragment,
  useRef,
  type ClipboardEventHandler,
  type ReactNode,
} from "react";
import {
  Activity,
  Bot,
  Brain,
  Calendar,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  Diff,
  Info,
  KeyRound,
  Link,
  MessageSquareText,
  Minimize2,
  Send,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { HighlightedCode } from "../code";
import {
  detectLanguage,
  transcriptRoleKind,
  formatMessageTimestamp,
  transcriptMessageActorLabel,
  unavailableTranscriptLabel,
} from "../format";
import { cn } from "../styles";
import { conversationTranscriptMessages } from "./eventTranscript";
import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewSubagentPart,
} from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { TranscriptText } from "./TranscriptText";
import { TranscriptSubagentView } from "./TranscriptSubagentView";
import { TranscriptContextEventView } from "./TranscriptContextEventView";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";
import {
  isCollapsibleActivityEntry,
  TranscriptActivityGroup,
} from "./TranscriptActivityGroup";
import { TranscriptToolView } from "./TranscriptToolView";
import { TranscriptReasoningView } from "./TranscriptReasoningView";
import { TranscriptStructuredEventView } from "./TranscriptStructuredEventView";
import { getDashboardAgentName } from "../agentName";
import { shouldCopyRawTranscript } from "./transcriptCopy";
import {
  groupTranscriptMessages,
  messageRawText,
  type RenderedTranscriptEntry,
  type TranscriptViewMode,
} from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";
import { SlackMark } from "./SlackMark";
import {
  entryMatchesSearch,
  HighlightText,
  useTranscriptSearch,
} from "./transcriptSearch";
import { showsSlackSourceIcon } from "./transcriptSource";

type TranscriptEntry = ReturnType<typeof groupTranscriptMessages>[number];
type TranscriptContextEntry = Extract<TranscriptEntry, { kind: "context" }>;
type TranscriptFailureEntry = Extract<TranscriptEntry, { kind: "failure" }>;
type TranscriptMessageEntry = Extract<TranscriptEntry, { kind: "message" }>;
type TranscriptStructuredEventEntry = Extract<
  TranscriptEntry,
  { kind: "structured_event" }
>;
type TranscriptReasoningEntry = Extract<TranscriptEntry, { kind: "reasoning" }>;
type TranscriptSubagentEntry = Extract<TranscriptEntry, { kind: "subagent" }>;
type TranscriptToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

function renderReasoningEntry(entry: TranscriptReasoningEntry): ReactNode {
  return (
    <TranscriptReasoningView part={entry.part} timestamp={entry.timestamp} />
  );
}

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
  const messages = conversationTranscriptMessages(props.conversation);

  return (
    <section className="min-w-0 py-1">
      <div className="min-w-0">
        <SegmentEvents
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.conversation}
          messages={messages}
          responding={props.responding ?? false}
          view={props.view}
        />
        {props.responding ? <TypingIndicator /> : null}
      </div>
    </section>
  );
}

function TypingIndicator() {
  return (
    <div aria-live="polite" className="mt-3 flex items-center" role="status">
      <span className="sr-only">{getDashboardAgentName()} is responding</span>
      <span className="flex items-center gap-1 rounded-2xl bg-dashboard-fill-soft px-3.5 py-2.5">
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

function transcriptRoleLabel(
  message: TranscriptViewMessage,
  conversation: ConversationTranscript,
): string {
  return transcriptMessageActorLabel(conversation, message);
}

function transcriptMessageClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-2xl px-3 py-2 md:gap-1.5 md:px-3.5 md:py-2.5",
    kind === "assistant" &&
      "mr-6 bg-dashboard-bubble-assistant text-dashboard-text md:mr-[18%]",
    kind === "user" &&
      "ml-6 bg-dashboard-surface-hover text-dashboard-text md:ml-[22%]",
    kind === "system" &&
      "rounded-xl border border-amber-300/10 bg-dashboard-bubble-warning text-dashboard-text",
    kind === "tool" && "rounded-none px-0 text-dashboard-text-muted",
    kind === "other" && "bg-dashboard-surface-hover text-dashboard-text",
  );
}

function transcriptRoleClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "text-xs leading-snug",
    kind === "assistant" && "text-cyan-100/70",
    kind === "user" && "text-dashboard-text-muted",
    kind === "system" && "text-amber-200/80",
    kind === "tool" && "text-dashboard-text-muted",
    kind === "other" && "text-dashboard-text-muted",
  );
}

function transcriptRoleLabelClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "inline-block max-w-full truncate font-display text-xs font-semibold leading-tight md:text-sm",
    kind === "assistant" && "text-cyan-100",
    kind === "user" && "text-dashboard-text",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-dashboard-text-muted",
    kind === "other" && "text-dashboard-text",
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
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
}) {
  const showSlack = showsSlackSourceIcon(props.message, props.conversation);
  const metaText = (props.meta ?? []).filter(isString).join(" · ");
  const roleLabel = transcriptRoleLabel(props.message, props.conversation);

  return (
    <TranscriptHeadingRow
      left={
        <span className={transcriptRoleLabelClass(props.message.role)}>
          {roleLabel}
        </span>
      }
      leftClassName={transcriptRoleClass(props.message.role)}
      right={
        showSlack || metaText ? (
          <TranscriptHeadingMeta className="flex min-w-0 items-center gap-1.5 break-words text-2xs leading-snug text-dashboard-text-muted/80 md:leading-none">
            {showSlack ? (
              <span className="inline-flex shrink-0" title="Slack">
                <SlackMark className="size-3.5" />
              </span>
            ) : null}
            {showSlack && metaText ? <span aria-hidden="true">·</span> : null}
            {metaText}
          </TranscriptHeadingMeta>
        ) : undefined
      }
    />
  );
}

function SegmentEvents(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
  messages: TranscriptViewMessage[];
  responding: boolean;
  view: TranscriptViewMode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 pt-1">
      {props.conversation.eventHistory.status === "available" ? (
        <VisibleTranscriptEntries
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={props.messages}
          conversation={props.conversation}
          responding={props.responding}
          view={props.view}
        />
      ) : props.conversation.eventHistory.status === "redacted" &&
        props.messages.length > 0 ? (
        <RedactedTranscriptView
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.conversation}
          messages={props.messages}
        />
      ) : props.messages.length > 0 ? (
        <VisibleTranscriptEntries
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={props.messages}
          conversation={props.conversation}
          responding={props.responding}
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
  responding: boolean;
  view: TranscriptViewMode;
}) {
  return (
    <TranscriptEntryList
      entries={groupTranscriptMessages(props.transcript)}
      keyPrefix={props.conversation.conversationId}
      responding={props.responding}
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
        ) : entry.message.context ? (
          <TranscriptRailEvent kind="message_context">
            <TranscriptMessageContextView
              message={entry.message}
              conversation={props.conversation}
            />
          </TranscriptRailEvent>
        ) : (
          <TranscriptMessageView
            message={entry.message}
            conversation={props.conversation}
            view={props.view}
          />
        )
      }
      renderStructuredEvent={(entry) => (
        <TranscriptRailEvent
          icon={structuredEventIcon(entry.part.presentation.icon)}
          kind="structured_event"
        >
          <TranscriptStructuredEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
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
      renderReasoning={renderReasoningEntry}
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
  responding?: boolean;
  renderContext: (entry: TranscriptContextEntry) => ReactNode;
  renderFailure: (entry: TranscriptFailureEntry) => ReactNode;
  renderMessage: (entry: TranscriptMessageEntry) => ReactNode;
  renderStructuredEvent: (entry: TranscriptStructuredEventEntry) => ReactNode;
  renderReasoning: (entry: TranscriptReasoningEntry) => ReactNode;
  renderSubagent: (entry: TranscriptSubagentEntry) => ReactNode;
  renderTool: (entry: TranscriptToolEntry) => ReactNode;
}) {
  const search = useTranscriptSearch();
  const activityKeys = useRef(new Map<string, string>());
  const claimedActivityKeys = new Set<string>();
  const rows: ReactNode[] = [];

  const renderEntry = (entry: TranscriptEntry): ReactNode => {
    if (entry.kind === "subagent") return props.renderSubagent(entry);
    if (entry.kind === "context") return props.renderContext(entry);
    if (entry.kind === "structured_event") {
      return props.renderStructuredEvent(entry);
    }
    if (entry.kind === "failure") return props.renderFailure(entry);
    if (entry.kind === "reasoning") return props.renderReasoning(entry);
    if (entry.kind === "tool") return props.renderTool(entry);
    return props.renderMessage(entry);
  };

  for (let index = 0; index < props.entries.length; ) {
    const entry = props.entries[index]!;

    if (isCollapsibleActivityEntry(entry)) {
      const activityEntries: RenderedTranscriptEntry[] = [];
      while (
        index < props.entries.length &&
        isCollapsibleActivityEntry(props.entries[index]!)
      ) {
        activityEntries.push(props.entries[index]!);
        index += 1;
      }
      const visibleEntries = search.active
        ? activityEntries.filter((candidate) =>
            entryMatchesSearch(candidate, search.normalizedQuery),
          )
        : activityEntries;
      if (visibleEntries.length > 0) {
        const activityKey = stableActivityGroupKey({
          claimedKeys: claimedActivityKeys,
          entries: activityEntries,
          keyPrefix: props.keyPrefix,
          knownKeys: activityKeys.current,
        });
        rows.push(
          <TranscriptActivityGroup
            activeTail={
              Boolean(props.responding) && index === props.entries.length
            }
            entries={visibleEntries}
            key={activityKey}
            renderEntry={renderEntry}
          />,
        );
      }
      continue;
    }

    if (!search.active || entryMatchesSearch(entry, search.normalizedQuery)) {
      rows.push(
        <Fragment key={`${props.keyPrefix}:${entry.key}`}>
          {renderEntry(entry)}
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

  return <div className="grid min-w-0 gap-3">{rows}</div>;
}

/** Keep one activity group mounted while new or historical events extend either edge. */
function stableActivityGroupKey(args: {
  claimedKeys: Set<string>;
  entries: RenderedTranscriptEntry[];
  keyPrefix: string;
  knownKeys: Map<string, string>;
}): string {
  const entryKeys = args.entries.map(
    (entry) => `${args.keyPrefix}:${entry.key}`,
  );
  const knownKey = entryKeys
    .map((entryKey) => args.knownKeys.get(entryKey))
    .find((key) => key !== undefined && !args.claimedKeys.has(key));
  const groupKey =
    knownKey ?? `${args.keyPrefix}:activity:${args.entries[0]!.key}`;

  args.claimedKeys.add(groupKey);
  entryKeys.forEach((entryKey) => args.knownKeys.set(entryKey, groupKey));
  return groupKey;
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
        <div className="font-display text-base font-semibold leading-tight">
          {deliveryFailed ? "Message delivery failed" : "Agent response failed"}
        </div>
        <div className="mt-1 text-sm leading-relaxed text-rose-100/70">
          {deliveryFailed
            ? `${getDashboardAgentName()} could not deliver this message to its destination.`
            : `The model response ended before ${getDashboardAgentName()} could complete this turn.`}
        </div>
      </div>
      {timestamp ? (
        <span className="font-mono text-xs leading-none text-rose-100/55 max-md:col-start-2">
          {timestamp}
        </span>
      ) : null}
    </div>
  );
}

type TranscriptRailEventKind =
  | "compaction"
  | "handoff"
  | "message_context"
  | "resource_event"
  | "structured_event"
  | "subagent";

/** Mark noteworthy transcript events with an inline status icon. */
function TranscriptRailEvent(props: {
  children: ReactNode;
  icon?: LucideIcon;
  kind: TranscriptRailEventKind;
}) {
  const marker = transcriptRailMarker(props.kind);
  const Icon = props.icon ?? marker.icon;

  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5"
      data-transcript-rail-event={props.kind}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-2 grid size-6 place-items-center rounded-md border bg-dashboard-overlay",
          marker.className,
        )}
      >
        <Icon size={12} strokeWidth={2.2} />
      </span>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}

function transcriptRailMarker(kind: TranscriptRailEventKind): {
  className: string;
  icon: LucideIcon;
} {
  if (kind === "message_context") {
    return {
      className: "border-dashboard-border-emphasis text-dashboard-text-muted",
      icon: MessageSquareText,
    };
  }
  if (kind === "resource_event") {
    return {
      className: "border-violet-300/35 text-violet-200",
      icon: Diff,
    };
  }
  if (kind === "structured_event") {
    return {
      className: "border-violet-300/35 text-violet-200",
      icon: Activity,
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

const structuredEventIcons: Record<
  NonNullable<TranscriptStructuredEventEntry["part"]["presentation"]["icon"]>,
  LucideIcon
> = {
  activity: Activity,
  brain: Brain,
  calendar: Calendar,
  check: Check,
  database: Database,
  info: Info,
  key: KeyRound,
  link: Link,
  sparkles: Sparkles,
  warning: TriangleAlert,
};

function structuredEventIcon(
  icon: TranscriptStructuredEventEntry["part"]["presentation"]["icon"],
): LucideIcon {
  return icon ? structuredEventIcons[icon] : Activity;
}

function RedactedTranscriptView(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
  messages: TranscriptViewMessage[];
}) {
  return (
    <TranscriptEntryList
      entries={groupTranscriptMessages(props.messages)}
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
        ) : entry.message.context ? (
          <TranscriptRailEvent kind="message_context">
            <TranscriptMessageContextView
              message={entry.message}
              conversation={props.conversation}
              redacted
            />
          </TranscriptRailEvent>
        ) : (
          <RedactedMessageView
            message={entry.message}
            conversation={props.conversation}
          />
        )
      }
      renderStructuredEvent={(entry) => (
        <TranscriptRailEvent
          icon={structuredEventIcon(entry.part.presentation.icon)}
          kind="structured_event"
        >
          <TranscriptStructuredEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
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
      renderReasoning={renderReasoningEntry}
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
        message={props.message}
        conversation={props.conversation}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 font-mono text-base leading-snug text-dashboard-text-muted">
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
        <span className="min-w-0 break-words text-right text-dashboard-text-muted max-md:text-left">
          {props.meta}
        </span>
      ) : null}
    </div>
  );
}

function RedactedMarker() {
  return (
    <code className="inline-flex w-fit font-mono text-sm leading-tight text-dashboard-text-muted">
      {"<redacted>"}
    </code>
  );
}

function TranscriptMessageContextView(props: {
  conversation: ConversationTranscript;
  message: TranscriptMessageEntry["message"];
  redacted?: boolean;
}) {
  const actor = transcriptRoleLabel(props.message, props.conversation);
  const timestamp = formatMessageTimestamp(props.message.timestamp);
  const text = messageRawText(props.message);

  const content = props.redacted ? (
    <RedactedMarker />
  ) : (
    <HighlightText text={text} />
  );

  return (
    <>
      <details
        className="group/message-context min-w-0 rounded-lg bg-dashboard-fill-soft px-3 py-2.5 md:hidden"
        data-transcript-message-context
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-display text-xs font-semibold text-dashboard-text-muted [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 truncate">Context from {actor}</span>
          <ChevronRight
            aria-hidden="true"
            className="shrink-0 transition-transform group-open/message-context:rotate-90"
            size={14}
          />
        </summary>
        <div className="mt-2 whitespace-pre-wrap pt-2 text-sm leading-relaxed text-dashboard-text/75">
          {content}
        </div>
        {!props.redacted && props.message.contexts?.length ? (
          <div className="mt-2">
            <TranscriptTurnContextView contexts={props.message.contexts} />
          </div>
        ) : null}
      </details>
      <article
        className="hidden min-w-0 rounded-lg bg-dashboard-fill-soft px-3 py-2.5 md:block"
        data-transcript-message-context
      >
        <TranscriptHeadingRow
          left={
            <span className="font-display text-xs font-semibold text-dashboard-text-muted">
              Context from {actor}
            </span>
          }
          leftClassName="min-w-0"
          right={
            timestamp ? (
              <TranscriptHeadingMeta className="font-mono text-2xs text-dashboard-text-muted/70">
                {timestamp}
              </TranscriptHeadingMeta>
            ) : undefined
          }
        />
        <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-dashboard-text/75">
          {content}
        </div>
        {!props.redacted && props.message.contexts?.length ? (
          <div className="mt-2">
            <TranscriptTurnContextView contexts={props.message.contexts} />
          </div>
        ) : null}
      </article>
    </>
  );
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
      <summary className="cursor-pointer list-none font-display text-sm font-semibold text-violet-100 [&::-webkit-details-marker]:hidden">
        <HighlightText text={props.message.eventType ?? ""} />
      </summary>
      {text ? (
        <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-dashboard-text-muted">
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
        message={props.message}
        conversation={props.conversation}
      />
      {props.view === "raw" ? (
        <HighlightedCode
          code={rawText || "{}"}
          language={detectLanguage(rawText)}
        />
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {props.message.parts.map((part, index) => (
            <TranscriptText key={index} role={role} text={part.text ?? ""} />
          ))}
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

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
