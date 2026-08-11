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
  CircleAlert,
  Database,
  Diff,
  Info,
  KeyRound,
  Link,
  Minimize2,
  Send,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ConversationPendingMessage } from "@sentry/junior/api/schema";

import { HighlightedCode } from "../code";
import {
  detectLanguage,
  transcriptRoleKind,
  formatMessageTimestamp,
  transcriptMessageActorLabel,
  unavailableTranscriptLabel,
  visualStatusForSummary,
} from "../format";
import { cn } from "../styles";
import { ShimmerText } from "../components/ShimmerText";
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
import { TranscriptToolRun } from "./TranscriptToolRun";
import { TranscriptToolView } from "./TranscriptToolView";
import { TranscriptReasoningView } from "./TranscriptReasoningView";
import { TranscriptStructuredEventView } from "./TranscriptStructuredEventView";
import { getDashboardAgentName } from "../agentName";
import { shouldCopyRawTranscript } from "./transcriptCopy";
import {
  groupTranscriptMessages,
  messageRawText,
  type RenderedReasoningEntry,
  type RenderedToolEntry,
  type TranscriptViewMode,
} from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";
import {
  entryMatchesSearch,
  HighlightText,
  useTranscriptSearch,
} from "./transcriptSearch";
import { ActiveIndicator } from "../components/ActiveIndicator";

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
  pendingMessages?: readonly ConversationPendingMessage[];
  responding?: boolean;
  view: TranscriptViewMode;
}) {
  const status = visualStatusForSummary(props.conversation);
  const committedMessages = conversationTranscriptMessages(props.conversation);
  const messages = conversationTranscriptMessages(
    props.conversation,
    props.pendingMessages,
  );
  const pendingMessages = messages.slice(committedMessages.length);

  return (
    <section className="grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)] gap-3 py-3">
      <div className="flex flex-col items-center pt-1.5" aria-hidden="true">
        <TurnMarker status={status} />
        <span className="mt-2 w-px flex-1 bg-cyan-300/15" />
      </div>
      <div className="min-w-0">
        <SegmentEvents
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.conversation}
          messages={committedMessages}
          view={props.view}
        />
        {props.responding ? <TypingIndicator /> : null}
        {pendingMessages.length > 0 ? (
          <PendingTranscriptEntries
            conversation={props.conversation}
            messages={pendingMessages}
            view={props.view}
          />
        ) : null}
      </div>
    </section>
  );
}

function TypingIndicator() {
  return (
    <div aria-live="polite" className="mt-2 flex items-center" role="status">
      <span className="sr-only">{getDashboardAgentName()} is responding</span>
      <span className="flex items-center gap-1 rounded-lg bg-cyan-300/[0.055] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
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

function TurnMarker(props: {
  status: ReturnType<typeof visualStatusForSummary>;
}) {
  if (props.status === "active") {
    return <ActiveIndicator className="size-2.5 border border-emerald-300" />;
  }

  return (
    <span
      className={cn(
        "size-2.5 shrink-0 rounded-full border",
        props.status === "failed" && "border-rose-300 bg-rose-300",
        props.status === "idle" && "border-cyan-300/60 bg-cyan-300/40",
      )}
    />
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
    "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg px-3 py-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.12)] md:px-4 md:py-3",
    kind === "assistant" &&
      "md:mr-6 bg-cyan-300/[0.055] text-dashboard-text",
    kind === "user" && "md:ml-6 bg-white/[0.055] text-dashboard-text",
    kind === "system" && "bg-amber-300/[0.045] text-dashboard-text",
    kind === "tool" && "bg-black/15 text-dashboard-text-muted shadow-none",
    kind === "other" && "bg-white/[0.03] text-dashboard-text",
  );
}

function pendingDeliveryLabel(
  delivery: TranscriptViewMessage["delivery"],
): string | undefined {
  if (delivery === "interrupt") return "Interrupts current turn";
  if (delivery === "defer") return "Queued after current turn";
  return undefined;
}

function transcriptRoleClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "text-sm leading-snug",
    kind === "assistant" && "text-cyan-100/75",
    kind === "user" && "text-dashboard-text",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-dashboard-text-muted",
    kind === "other" && "text-dashboard-text",
  );
}

function transcriptRoleLabelClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "inline-block max-w-full truncate font-display text-base font-semibold leading-tight",
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
  const source =
    props.message.source ??
    (props.conversation.surface === "slack" ? "slack" : undefined);
  const sourceLabel =
    source === "slack" ? "Slack" : source === "web" ? "Dashboard" : undefined;
  const pendingLabel = props.message.pending ? "Pending" : undefined;
  const deliveryLabel = props.message.pending
    ? pendingDeliveryLabel(props.message.delivery)
    : undefined;
  const metaParts = [
    sourceLabel,
    pendingLabel,
    deliveryLabel,
    ...(props.meta ?? []),
  ].filter(isString);
  const metaText = metaParts.join(" · ");
  const roleLabel = transcriptRoleLabel(props.message, props.conversation);

  return (
    <TranscriptHeadingRow
      left={
        <span className={transcriptRoleLabelClass(props.message.role)}>
          {props.message.pending ? (
            <ShimmerText active>{roleLabel}</ShimmerText>
          ) : (
            roleLabel
          )}
        </span>
      }
      leftClassName={transcriptRoleClass(props.message.role)}
      right={
        metaText ? (
          <TranscriptHeadingMeta className="block min-w-0 break-words text-xs leading-snug text-dashboard-text-muted md:leading-none">
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
  view: TranscriptViewMode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pt-3">
      {props.conversation.eventHistory.status === "available" ? (
        <VisibleTranscriptEntries
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={props.messages}
          conversation={props.conversation}
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

function PendingTranscriptEntries(props: {
  conversation: ConversationTranscript;
  messages: TranscriptViewMessage[];
  view: TranscriptViewMode;
}) {
  // One continuous stack above the composer: shared fill, no gaps, only outer
  // corners rounded — same shape as ChatGPT's queued follow-up rows.
  return (
    <div
      aria-label="Pending messages"
      className="mt-6 overflow-hidden rounded-lg bg-cyan-300/[0.07]"
    >
      {props.messages.map((message, index) => (
        <PendingTranscriptMessage
          conversation={props.conversation}
          key={message.messageId ?? `${message.sourceSeq}:${index}`}
          message={message}
          showDivider={index > 0}
          view={props.view}
        />
      ))}
    </div>
  );
}

function PendingTranscriptMessage(props: {
  conversation: ConversationTranscript;
  message: TranscriptViewMessage;
  showDivider: boolean;
  view: TranscriptViewMode;
}) {
  const rawText = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );

  return (
    <article
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-3 py-2.5 text-dashboard-text md:px-4 md:py-3",
        props.showDivider && "border-t border-white/[0.06]",
      )}
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
      ) : redacted ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 font-mono text-base leading-snug text-dashboard-text-muted">
          <RedactedMarker />
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {props.message.parts.map((part, index) =>
            part.type === "text" ? (
              <TranscriptText
                key={index}
                role={props.message.role}
                text={part.text ?? ""}
              />
            ) : null,
          )}
        </div>
      )}
    </article>
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
  renderContext: (entry: TranscriptContextEntry) => ReactNode;
  renderFailure: (entry: TranscriptFailureEntry) => ReactNode;
  renderMessage: (entry: TranscriptMessageEntry) => ReactNode;
  renderStructuredEvent: (entry: TranscriptStructuredEventEntry) => ReactNode;
  renderReasoning: (entry: TranscriptReasoningEntry) => ReactNode;
  renderSubagent: (entry: TranscriptSubagentEntry) => ReactNode;
  renderTool: (entry: TranscriptToolEntry) => ReactNode;
}) {
  const search = useTranscriptSearch();
  const toolRunKeys = useRef(new Map<string, string>());
  const claimedToolRunKeys = new Set<string>();
  const rows: ReactNode[] = [];

  for (let index = 0; index < props.entries.length; ) {
    const entry = props.entries[index]!;

    if (entry.kind === "tool" || entry.kind === "reasoning") {
      const runEntries: Array<RenderedReasoningEntry | RenderedToolEntry> = [];
      while (
        props.entries[index]?.kind === "tool" ||
        props.entries[index]?.kind === "reasoning"
      ) {
        runEntries.push(
          props.entries[index] as RenderedReasoningEntry | RenderedToolEntry,
        );
        index += 1;
      }
      const visibleEntries = search.active
        ? runEntries.filter((e) =>
            entryMatchesSearch(e, search.normalizedQuery),
          )
        : runEntries;
      if (visibleEntries.length > 0) {
        const toolRunKey = stableToolRunKey({
          claimedKeys: claimedToolRunKeys,
          entries: runEntries,
          keyPrefix: props.keyPrefix,
          knownKeys: toolRunKeys.current,
        });
        rows.push(
          <TranscriptToolRun
            autoCollapse={index < props.entries.length}
            entries={visibleEntries}
            key={toolRunKey}
            renderReasoning={props.renderReasoning}
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
              : entry.kind === "structured_event"
                ? props.renderStructuredEvent(entry)
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

/** Keep one tool run mounted while new or historical events extend either edge. */
function stableToolRunKey(args: {
  claimedKeys: Set<string>;
  entries: Array<RenderedReasoningEntry | RenderedToolEntry>;
  keyPrefix: string;
  knownKeys: Map<string, string>;
}): string {
  const entryKeys = args.entries.map(
    (entry) => `${args.keyPrefix}:${entry.key}`,
  );
  const knownKey = entryKeys
    .map((entryKey) => args.knownKeys.get(entryKey))
    .find((key) => key !== undefined && !args.claimedKeys.has(key));
  const runKey =
    knownKey ?? `${args.keyPrefix}:tool-run:${args.entries[0]!.key}`;

  args.claimedKeys.add(runKey);
  entryKeys.forEach((entryKey) => args.knownKeys.set(entryKey, runKey));
  return runKey;
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
  | "resource_event"
  | "structured_event"
  | "subagent";

/** Anchor noteworthy transcript events to the same visual rail as turn markers. */
function TranscriptRailEvent(props: {
  children: ReactNode;
  icon?: LucideIcon;
  kind: TranscriptRailEventKind;
}) {
  const marker = transcriptRailMarker(props.kind);
  const Icon = props.icon ?? marker.icon;

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
