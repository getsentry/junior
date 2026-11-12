import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { History } from "lucide-react";
import { cn } from "../styles";
import type { ConversationMailboxMessage } from "./conversationOutbox";

import { EmptyTelemetry } from "../components/EmptyTelemetry";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Card } from "../components/layout/Card";
import { formatTime, unavailableTranscriptLabel } from "../format";
import { ConversationBrief } from "./ConversationBrief";
import { transcriptMessagesFromEvents } from "./eventTranscript";
import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewSubagentPart,
} from "../types";
import { TranscriptTasksLine } from "./TranscriptTasksLine";
import { TranscriptThreadCard } from "./TranscriptThreadCard";
import { TranscriptContextEventView } from "./TranscriptContextEventView";
import { TranscriptActivityGroup } from "./TranscriptActivityGroup";
import { TranscriptToolView } from "./TranscriptToolView";
import { TranscriptReasoningView } from "./TranscriptReasoningView";
import { TranscriptAttachmentsDeliveredView } from "./TranscriptAttachmentsDeliveredView";
import { TranscriptStructuredEventView } from "./TranscriptStructuredEventView";
import {
  TranscriptCapturedMemories,
  TranscriptRecalledMemories,
} from "./TranscriptMemoryPopover";
import { isMemoryCaptureEvent } from "./conversationMemory";
import { TranscriptFailureView } from "./TranscriptFailureView";
import {
  structuredEventIcon,
  TranscriptRailEvent,
} from "./TranscriptRailEvent";
import {
  TranscriptReplyRatings,
  useTranscriptReplyRatings,
} from "./ReplyRatingActions";
import { TranscriptMessageContextView } from "./TranscriptMessageContextView";
import {
  RedactedMessageView,
  TranscriptMessageView,
} from "./TranscriptMessageView";
import { TranscriptEventView } from "./TranscriptEventView";
import {
  isAutomationTriggerMessage,
  TranscriptAutomationTriggerView,
} from "./TranscriptAutomationTriggerView";
import { TranscriptTypingIndicator } from "./TranscriptTypingIndicator";
import { groupTranscriptMessages } from "./transcriptRenderModel";
import { useTranscriptSearch } from "./transcriptSearch";
import {
  TranscriptOpenRows,
  TranscriptRow,
  TranscriptRows,
  TranscriptUnreadMarker,
} from "./TranscriptRows";
import {
  askRowIndex,
  defaultTranscriptRowSize,
  liveActivityIndex,
  rowIndexForSeq,
  transcriptListRows,
  transcriptRowSizeClass,
  UNREAD_MARKER_KEY,
  type TranscriptListRow,
} from "./transcriptListRows";
import { useVirtualRows } from "./virtualRows";
import { TranscriptImagesProvider } from "./TranscriptAttachment";
import { TranscriptTimestampProvider } from "./TranscriptTimestamp";
import type { TranscriptUnreadRange } from "./transcriptReadPosition";

type TranscriptEntry = ReturnType<typeof groupTranscriptMessages>[number];
type TranscriptContextEntry = Extract<TranscriptEntry, { kind: "context" }>;
type TranscriptFailureEntry = Extract<TranscriptEntry, { kind: "failure" }>;
type TranscriptMessageEntry = Extract<TranscriptEntry, { kind: "message" }>;
type TranscriptAttachmentsDeliveredEntry = Extract<
  TranscriptEntry,
  { kind: "attachments_delivered" }
>;
type TranscriptStructuredEventEntry = Extract<
  TranscriptEntry,
  { kind: "structured_event" }
>;
type TranscriptReasoningEntry = Extract<TranscriptEntry, { kind: "reasoning" }>;
type TranscriptSubagentEntry = Extract<TranscriptEntry, { kind: "subagent" }>;
type TranscriptToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** How long the row of a shown question stays marked. */
const ASK_HIGHLIGHT_MS = 1_600;

/**
 * Show the transcript row of a question that Junior asked. `version`
 * changes on each request, so the same question can show again. `arrived`
 * means the question came by itself, not by an action of the reader.
 */
export type TranscriptAskReveal = {
  arrived: boolean;
  itemId: string;
  version: number;
};

/** The current ask request, and the scroll owner that shows its row. */
export const TranscriptAskRevealContext = createContext<
  | (TranscriptAskReveal & {
      showRow(row: Element, options: { arrived: boolean }): boolean;
    })
  | undefined
>(undefined);

function renderReasoningEntry(entry: TranscriptReasoningEntry): ReactNode {
  return (
    <TranscriptReasoningView
      openKey={entry.key}
      part={entry.part}
      timestamp={entry.timestamp}
    />
  );
}

function renderThreadEntry(entry: TranscriptSubagentEntry): ReactNode {
  return (
    <TranscriptRailEvent kind="thread">
      <TranscriptThreadCard part={entry.part} timestamp={entry.timestamp} />
    </TranscriptRailEvent>
  );
}

function renderTaskEntries(
  entries: TranscriptSubagentEntry[],
  onOpenTranscript: (part: TranscriptViewSubagentPart) => void,
): ReactNode {
  return (
    <TranscriptTasksLine
      entries={entries}
      onOpenTranscript={onOpenTranscript}
    />
  );
}

/** Render one conversation transcript segment as actor messages and tool events. */
export const ConversationTranscriptView = memo(
  function ConversationTranscriptView(props: {
    onOpenSubagentTranscript?: (args: {
      part: TranscriptViewSubagentPart;
      conversation: ConversationTranscript;
    }) => void;
    conversation: ConversationTranscript;
    /** Sends that history does not have yet. History wins on message id. */
    pendingMessages?: readonly ConversationMailboxMessage[];
    responding?: boolean;
    /** Keep the rows around this event seq mounted, to show it. */
    revealSeq?: number;
    /** The row that holds the reader's place, from the scroll owner. */
    scrollAnchorKey?: () => string | undefined;
    /** Show the "New" marker before the first row in this range. */
    unread?: TranscriptUnreadRange;
  }) {
    // Cards can change while their Message events stay unchanged.
    const { events, annotations } = props.conversation;
    const messages = useMemo(
      () =>
        transcriptMessagesFromEvents(
          events,
          annotations,
          props.pendingMessages,
        ),
      [events, annotations, props.pendingMessages],
    );

    return (
      <TranscriptTimestampProvider>
        <TranscriptImagesProvider
          conversationId={props.conversation.conversationId}
          messages={messages}
        >
          <section className="min-w-0 pt-1">
            <SegmentEvents
              onOpenSubagentTranscript={props.onOpenSubagentTranscript}
              conversation={props.conversation}
              messages={messages}
              responding={props.responding}
              revealSeq={props.revealSeq}
              scrollAnchorKey={props.scrollAnchorKey}
              unread={props.unread}
            />
          </section>
        </TranscriptImagesProvider>
      </TranscriptTimestampProvider>
    );
  },
);

function SegmentEvents(
  props: TranscriptListPlacement & {
    onOpenSubagentTranscript?: (args: {
      part: TranscriptViewSubagentPart;
      conversation: ConversationTranscript;
    }) => void;
    conversation: ConversationTranscript;
    messages: TranscriptViewMessage[];
    responding?: boolean;
    unread?: TranscriptUnreadRange;
  },
) {
  const placement = {
    revealSeq: props.revealSeq,
    scrollAnchorKey: props.scrollAnchorKey,
  };
  return (
    <TranscriptRows>
      {props.conversation.eventHistory.status === "expired" ? (
        <>
          <ExpiredTranscriptView
            brief={props.conversation.brief}
            expiredAt={props.conversation.eventHistory.expiredAt}
          />
          {props.responding ? <TranscriptThinkingRow /> : null}
        </>
      ) : props.conversation.eventHistory.status === "available" ? (
        <VisibleTranscriptEntries
          {...placement}
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          responding={props.responding}
          transcript={props.messages}
          conversation={props.conversation}
          unread={props.unread}
        />
      ) : props.conversation.eventHistory.status === "redacted" &&
        props.messages.length > 0 ? (
        <RedactedTranscriptView
          {...placement}
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.conversation}
          messages={props.messages}
          responding={props.responding}
        />
      ) : props.messages.length > 0 ? (
        <VisibleTranscriptEntries
          {...placement}
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          responding={props.responding}
          transcript={props.messages}
          conversation={props.conversation}
        />
      ) : (
        <>
          <EmptyTelemetry>
            {unavailableTranscriptLabel(props.conversation)}
          </EmptyTelemetry>
          {props.responding ? <TranscriptThinkingRow /> : null}
        </>
      )}
    </TranscriptRows>
  );
}

function TranscriptThinkingRow() {
  return (
    <TranscriptRow indent>
      <TranscriptTypingIndicator />
    </TranscriptRow>
  );
}

function ExpiredTranscriptView(props: {
  brief: ConversationTranscript["brief"];
  expiredAt: string;
}) {
  return (
    <>
      {props.brief ? (
        <Card as="section" padding="md" variant="section">
          <h3 className="mt-0 mb-3 font-display text-lg font-medium text-dashboard-text">
            Brief
          </h3>
          <ConversationBrief brief={props.brief} />
        </Card>
      ) : null}
      <Empty className="flex items-start gap-3 border-dashed border-dashboard-border-emphasis bg-dashboard-fill-soft">
        <EmptyMedia>
          <History />
        </EmptyMedia>
        <div className="min-w-0">
          <EmptyTitle>Transcript expired</EmptyTitle>
          <EmptyDescription className="mt-1 text-sm">
            The retention policy removed these events on{" "}
            <time dateTime={props.expiredAt}>
              {formatTime(props.expiredAt, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
            .{props.brief ? " The brief above is still available." : null}
          </EmptyDescription>
        </div>
      </Empty>
    </>
  );
}

const VisibleTranscriptEntries = memo(function VisibleTranscriptEntries(
  props: TranscriptListPlacement & {
    onOpenSubagentTranscript?: (args: {
      part: TranscriptViewSubagentPart;
      conversation: ConversationTranscript;
    }) => void;
    responding?: boolean;
    transcript: TranscriptViewMessage[];
    conversation: ConversationTranscript;
    unread?: TranscriptUnreadRange;
  },
) {
  const entries = useMemo(
    () => groupTranscriptMessages(props.transcript),
    [props.transcript],
  );
  return (
    <TranscriptEntryList
      entries={entries}
      // Open rows and row sizes belong to one Conversation.
      key={props.conversation.conversationId}
      keyPrefix={props.conversation.conversationId}
      responding={props.responding}
      revealSeq={props.revealSeq}
      scrollAnchorKey={props.scrollAnchorKey}
      unread={props.unread}
      renderContext={(entry) => (
        <TranscriptRailEvent kind="compaction">
          <TranscriptContextEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderFailure={(entry) => (
        <TranscriptFailureView
          eventId={entry.eventId}
          failureCode={entry.failureCode}
          failureReason={entry.failureReason}
          sentryEventUrl={entry.sentryEventUrl}
          timestamp={entry.timestamp}
        />
      )}
      renderMessage={(entry, footer) =>
        props.conversation.sourceTask &&
        isAutomationTriggerMessage(props.conversation, entry.message) ? (
          <div className="grid min-w-0 gap-2">
            <TranscriptAutomationTriggerView
              message={entry.message}
              sourceTask={props.conversation.sourceTask}
            />
            <TranscriptRecalledMemories message={entry.message} />
          </div>
        ) : entry.message.eventType ? (
          <TranscriptRailEvent
            kind="event"
            objectType={entry.message.eventObjectType}
          >
            <TranscriptEventView
              conversationId={props.conversation.conversationId}
              message={entry.message}
              openKey={entry.key}
            />
            <TranscriptRecalledMemories
              className="mt-1"
              message={entry.message}
            />
          </TranscriptRailEvent>
        ) : entry.message.context ? (
          <TranscriptRailEvent kind="message_context">
            <TranscriptMessageContextView
              message={entry.message}
              conversation={props.conversation}
            />
            <TranscriptRecalledMemories
              className="mt-2"
              message={entry.message}
            />
          </TranscriptRailEvent>
        ) : (
          <TranscriptMessageView
            footer={footer}
            message={entry.message}
            conversation={props.conversation}
          />
        )
      }
      renderAttachmentsDelivered={(entry) => (
        <TranscriptAttachmentsDeliveredView
          conversation={props.conversation}
          part={entry.part}
          timestamp={entry.timestamp}
        />
      )}
      renderStructuredEvent={(entry) => (
        <TranscriptRailEvent
          icon={structuredEventIcon(entry.part.presentation.icon)}
          kind="structured_event"
        >
          {isMemoryCaptureEvent(entry.part) ? (
            <TranscriptCapturedMemories
              fallback={
                <TranscriptStructuredEventView
                  part={entry.part}
                  timestamp={entry.timestamp}
                />
              }
              timestamp={entry.timestamp}
              turnId={entry.part.turnId}
            />
          ) : (
            <TranscriptStructuredEventView
              part={entry.part}
              timestamp={entry.timestamp}
            />
          )}
        </TranscriptRailEvent>
      )}
      renderThread={renderThreadEntry}
      renderTasks={(entries) =>
        renderTaskEntries(entries, (part) =>
          props.onOpenSubagentTranscript?.({
            part,
            conversation: props.conversation,
          }),
        )
      }
      renderReasoning={renderReasoningEntry}
      renderTool={(entry) => (
        <TranscriptToolView
          conversationId={props.conversation.conversationId}
          part={entry.part}
          timestamp={entry.timestamp}
        />
      )}
    />
  );
});

type TranscriptEntryRenderers = {
  renderAttachmentsDelivered: (
    entry: TranscriptAttachmentsDeliveredEntry,
  ) => ReactNode;
  renderContext: (entry: TranscriptContextEntry) => ReactNode;
  renderFailure: (entry: TranscriptFailureEntry) => ReactNode;
  /** `footer` goes under the message text, such as the Turn's Tasks. */
  renderMessage: (
    entry: TranscriptMessageEntry,
    footer?: ReactNode,
  ) => ReactNode;
  renderStructuredEvent: (entry: TranscriptStructuredEventEntry) => ReactNode;
  renderReasoning: (entry: TranscriptReasoningEntry) => ReactNode;
  renderThread: (entry: TranscriptSubagentEntry) => ReactNode;
  renderTasks: (entries: TranscriptSubagentEntry[]) => ReactNode;
  renderTool: (entry: TranscriptToolEntry) => ReactNode;
};

/**
 * Render transcript entries as list rows. Only the rows near the viewport
 * mount. These rows also stay mounted, because the scroll owner and the
 * page find them in the DOM: the row that holds the reader's place, the
 * "New" marker and the row after it, the rows around `revealSeq`, the
 * current search match, and the row of a shown question.
 */
function TranscriptEntryList(
  props: TranscriptEntryRenderers &
    TranscriptListPlacement & {
      entries: TranscriptEntry[];
      keyPrefix: string;
      /** A Turn is running, so the list ends with its progress. */
      responding?: boolean;
      unread?: TranscriptUnreadRange;
    },
) {
  const search = useTranscriptSearch();
  const activityKeys = useRef(new Map<string, string>());
  const [openRows] = useState(() => new Map<string, boolean>());
  const replyRatings = useTranscriptReplyRatings();
  const listRef = useRef<HTMLDivElement>(null);
  const searchQuery = search.active ? search.normalizedQuery : undefined;
  const rows = useMemo(
    () =>
      transcriptListRows({
        entries: props.entries,
        keyPrefix: props.keyPrefix,
        knownActivityKeys: activityKeys.current,
        search: searchQuery,
        unread: props.unread,
      }),
    [props.entries, props.keyPrefix, props.unread, searchQuery],
  );
  const indexByKey = useMemo(
    () => new Map(rows.map((row, index) => [row.key, index])),
    [rows],
  );
  const matchCount = searchQuery === undefined ? 0 : rows.length;
  const { match, onMatches } = search;
  // Search rows are all matches. Earlier history can put matches before
  // the current one, so report how many, and the current match stays on
  // its row. The current row stays mounted, so it can scroll into view like
  // a reveal. Scroll only when the reader steps to another row. A new query
  // or a loaded page does not scroll: a scroll to the top match shows the
  // history sentinel, and each loaded page would then load the next one.
  const shownMatch = useRef<{
    firstKey?: string;
    matchKey?: string;
    query?: string;
  }>({});
  useEffect(() => {
    const previous = shownMatch.current;
    const sameQuery = previous.query === searchQuery;
    const prepended =
      matchCount > 0 && sameQuery && previous.firstKey !== undefined
        ? (indexByKey.get(previous.firstKey) ?? 0)
        : 0;
    const current = Math.min(match + prepended, matchCount - 1);
    const matchKey = matchCount > 0 ? rows[current]?.key : undefined;
    shownMatch.current = {
      firstKey: rows[0]?.key,
      matchKey,
      query: searchQuery,
    };
    onMatches?.(matchCount, prepended);
    if (
      !sameQuery ||
      matchKey === undefined ||
      matchKey === previous.matchKey
    ) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [indexByKey, match, matchCount, onMatches, rows, searchQuery]);
  // The row of a shown question stays mounted, so it can scroll into view
  // and get its mark. A search can drop the row. Then nothing moves.
  const askReveal = use(TranscriptAskRevealContext);
  const askItemId = askReveal?.itemId;
  const askIndex = useMemo(
    () => (askItemId === undefined ? undefined : askRowIndex(rows, askItemId)),
    [askItemId, rows],
  );
  const shownAskVersion = useRef<number>(undefined);
  const askHighlight = useRef<{ record: Element; timer: number }>(undefined);
  useEffect(() => {
    const list = listRef.current;
    if (
      !list ||
      !askReveal ||
      askIndex === undefined ||
      shownAskVersion.current === askReveal.version
    ) {
      return;
    }
    // The row mounts, and its record loads its item, after the request.
    // Wait until the record is in the DOM, so the scroll sees its place.
    const show = () => {
      const row = list.querySelector(`[data-index="${askIndex}"]`);
      const record = row?.querySelector("[data-review-item-ask]");
      if (!row || !record) return false;
      shownAskVersion.current = askReveal.version;
      if (!askReveal.showRow(row, { arrived: askReveal.arrived })) return true;
      const previous = askHighlight.current;
      if (previous) {
        window.clearTimeout(previous.timer);
        previous.record.removeAttribute("data-highlighted");
      }
      record.setAttribute("data-highlighted", "");
      askHighlight.current = {
        record,
        timer: window.setTimeout(() => {
          record.removeAttribute("data-highlighted");
          askHighlight.current = undefined;
        }, ASK_HIGHLIGHT_MS),
      };
      return true;
    };
    if (show()) return;
    const observer = new MutationObserver(() => {
      if (show()) observer.disconnect();
    });
    observer.observe(list, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [askIndex, askReveal]);
  useEffect(() => () => window.clearTimeout(askHighlight.current?.timer), []);
  const anchorKey = props.scrollAnchorKey?.();
  const markerIndex = indexByKey.get(UNREAD_MARKER_KEY);
  // A memory row can sit at its event or on the message before it.
  const revealIndex =
    props.revealSeq === undefined
      ? undefined
      : rowIndexForSeq(rows, props.revealSeq);
  const virtualizer = useVirtualRows({
    count: rows.length,
    defaultSize: defaultTranscriptRowSize,
    // The gap between rows, like the gap of the transcript stack.
    gap: 4,
    getItemKey: (index) => rows[index]!.key,
    keptIndexes: [
      anchorKey === undefined ? undefined : indexByKey.get(anchorKey),
      // The scroll owner opens at the marker and holds the reader's place
      // at the first unread row after it.
      markerIndex,
      markerIndex === undefined ? undefined : markerIndex + 1,
      revealIndex,
      revealIndex === undefined ? undefined : revealIndex - 1,
      matchCount === 0 ? undefined : match,
      askIndex,
    ],
    listRef,
    sizeClass: (index) => transcriptRowSizeClass(rows[index]!),
  });
  // Rows render again only when the renderers change, not on each scroll.
  const {
    renderAttachmentsDelivered,
    renderContext,
    renderFailure,
    renderMessage,
    renderReasoning,
    renderStructuredEvent,
    renderThread,
    renderTasks,
    renderTool,
  } = props;
  const renderEntry = useCallback(
    (entry: TranscriptEntry, tasks?: TranscriptSubagentEntry[]): ReactNode => {
      // Only a Thread has an entry row. Tasks come under a reply or as a
      // Tasks row.
      if (entry.kind === "subagent") return renderThread(entry);
      if (entry.kind === "context") return renderContext(entry);
      if (entry.kind === "attachments_delivered") {
        return renderAttachmentsDelivered(entry);
      }
      if (entry.kind === "structured_event") {
        return renderStructuredEvent(entry);
      }
      if (entry.kind === "failure") return renderFailure(entry);
      if (entry.kind === "reasoning") return renderReasoning(entry);
      if (entry.kind === "tool") return renderTool(entry);
      return renderMessage(entry, tasks ? renderTasks(tasks) : undefined);
    },
    [
      renderAttachmentsDelivered,
      renderContext,
      renderFailure,
      renderMessage,
      renderReasoning,
      renderStructuredEvent,
      renderTasks,
      renderThread,
      renderTool,
    ],
  );

  // The running Turn shows its progress in its last activity row. Its Tasks
  // row comes after it, at the end of the Turn. Otherwise the thinking row
  // shows.
  const liveIndex =
    props.responding && !search.active ? liveActivityIndex(rows) : undefined;
  const thinking =
    props.responding && liveIndex === undefined ? (
      <TranscriptThinkingRow />
    ) : null;

  if (search.active && rows.length === 0) {
    return (
      <>
        <EmptyTelemetry>No events match your search.</EmptyTelemetry>
        {thinking}
      </>
    );
  }

  return (
    <>
      <TranscriptOpenRows value={openRows}>
        <TranscriptReplyRatings value={replyRatings}>
          <div
            className="relative min-w-0"
            ref={listRef}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => (
              <VirtualTranscriptRow
                current={matchCount > 0 && item.index === match}
                index={item.index}
                key={item.key}
                live={item.index === liveIndex}
                measure={virtualizer.measureElement}
                offset={item.start - virtualizer.options.scrollMargin}
                renderEntry={renderEntry}
                renderTasks={renderTasks}
                row={rows[item.index]!}
              />
            ))}
          </div>
        </TranscriptReplyRatings>
      </TranscriptOpenRows>
      {thinking}
    </>
  );
}

/** Where the list keeps rows mounted outside the viewport. */
type TranscriptListPlacement = {
  /** Keep the rows around this event seq mounted, to show it. */
  revealSeq?: number;
  /** The row that holds the reader's place, from the scroll owner. */
  scrollAnchorKey?: () => string | undefined;
};

/**
 * Place one list row at its offset. Rows render again only when their row
 * or offset changes, not when the mounted range changes.
 */
const VirtualTranscriptRow = memo(function VirtualTranscriptRow(props: {
  /** The current search match. */
  current: boolean;
  index: number;
  /** The activity row of the running Turn. */
  live: boolean;
  measure: (element: HTMLElement | null) => void;
  offset: number;
  renderEntry: (
    entry: TranscriptEntry,
    tasks?: TranscriptSubagentEntry[],
  ) => ReactNode;
  renderTasks: TranscriptEntryRenderers["renderTasks"];
  row: TranscriptListRow;
}) {
  const { row } = props;
  return (
    <div
      className={cn(
        "absolute left-0 top-0 w-full rounded-lg",
        props.current && "ring-1 ring-amber-400/40",
      )}
      data-index={props.index}
      ref={props.measure}
      style={{ transform: `translateY(${props.offset}px)` }}
    >
      {row.kind === "unread_marker" ? (
        <TranscriptUnreadMarker />
      ) : row.kind === "activity" ? (
        <TranscriptRow anchorKey={row.key} indent seq={row.seq}>
          <TranscriptActivityGroup
            entries={row.entries}
            live={props.live}
            openKey={row.key}
            renderEntry={props.renderEntry}
          />
        </TranscriptRow>
      ) : row.kind === "tasks" ? (
        <TranscriptRow anchorKey={row.key} indent seq={row.seq}>
          {props.renderTasks(row.entries)}
        </TranscriptRow>
      ) : (
        <TranscriptRow anchorKey={row.key} seq={row.seq}>
          {props.renderEntry(row.entry, row.tasks)}
        </TranscriptRow>
      )}
    </div>
  );
});

function RedactedTranscriptView(
  props: TranscriptListPlacement & {
    onOpenSubagentTranscript?: (args: {
      part: TranscriptViewSubagentPart;
      conversation: ConversationTranscript;
    }) => void;
    conversation: ConversationTranscript;
    messages: TranscriptViewMessage[];
    responding?: boolean;
  },
) {
  return (
    <TranscriptEntryList
      entries={groupTranscriptMessages(props.messages)}
      key={props.conversation.conversationId}
      keyPrefix={`${props.conversation.conversationId}:redacted`}
      responding={props.responding}
      revealSeq={props.revealSeq}
      scrollAnchorKey={props.scrollAnchorKey}
      renderContext={(entry) => (
        <TranscriptRailEvent kind="compaction">
          <TranscriptContextEventView
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
      )}
      renderFailure={(entry) => (
        <TranscriptFailureView
          eventId={entry.eventId}
          failureCode={entry.failureCode}
          failureReason={entry.failureReason}
          sentryEventUrl={entry.sentryEventUrl}
          timestamp={entry.timestamp}
        />
      )}
      renderMessage={(entry, footer) =>
        props.conversation.sourceTask &&
        isAutomationTriggerMessage(props.conversation, entry.message) ? (
          <TranscriptAutomationTriggerView
            message={entry.message}
            sourceTask={props.conversation.sourceTask}
          />
        ) : entry.message.eventType ? (
          <TranscriptRailEvent
            kind="event"
            objectType={entry.message.eventObjectType}
          >
            <TranscriptEventView
              conversationId={props.conversation.conversationId}
              message={entry.message}
              openKey={entry.key}
            />
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
            footer={footer}
            message={entry.message}
            conversation={props.conversation}
          />
        )
      }
      renderAttachmentsDelivered={(entry) => (
        <TranscriptAttachmentsDeliveredView
          conversation={props.conversation}
          part={entry.part}
          timestamp={entry.timestamp}
        />
      )}
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
      renderThread={renderThreadEntry}
      renderTasks={(entries) =>
        renderTaskEntries(entries, (part) =>
          props.onOpenSubagentTranscript?.({
            part,
            conversation: props.conversation,
          }),
        )
      }
      renderReasoning={renderReasoningEntry}
      renderTool={(entry) => (
        <TranscriptToolView
          conversationId={props.conversation.conversationId}
          part={entry.part}
          timestamp={entry.timestamp}
        />
      )}
    />
  );
}
