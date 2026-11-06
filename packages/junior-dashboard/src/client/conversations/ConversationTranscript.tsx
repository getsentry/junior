import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { History } from "lucide-react";
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
import { TranscriptSubagentView } from "./TranscriptSubagentView";
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
  defaultTranscriptRowSize,
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

function renderReasoningEntry(entry: TranscriptReasoningEntry): ReactNode {
  return (
    <TranscriptReasoningView
      openKey={entry.key}
      part={entry.part}
      timestamp={entry.timestamp}
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
        <ExpiredTranscriptView
          brief={props.conversation.brief}
          expiredAt={props.conversation.eventHistory.expiredAt}
        />
      ) : props.conversation.eventHistory.status === "available" ? (
        <VisibleTranscriptEntries
          {...placement}
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
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
        />
      ) : props.messages.length > 0 ? (
        <VisibleTranscriptEntries
          {...placement}
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={props.messages}
          conversation={props.conversation}
        />
      ) : (
        <EmptyTelemetry>
          {unavailableTranscriptLabel(props.conversation)}
        </EmptyTelemetry>
      )}
      {props.responding ? (
        <TranscriptRow indent>
          <TranscriptTypingIndicator />
        </TranscriptRow>
      ) : null}
    </TranscriptRows>
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
      renderMessage={(entry) =>
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
            <TranscriptEventView message={entry.message} openKey={entry.key} />
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
});

type TranscriptEntryRenderers = {
  renderAttachmentsDelivered: (
    entry: TranscriptAttachmentsDeliveredEntry,
  ) => ReactNode;
  renderContext: (entry: TranscriptContextEntry) => ReactNode;
  renderFailure: (entry: TranscriptFailureEntry) => ReactNode;
  renderMessage: (entry: TranscriptMessageEntry) => ReactNode;
  renderStructuredEvent: (entry: TranscriptStructuredEventEntry) => ReactNode;
  renderReasoning: (entry: TranscriptReasoningEntry) => ReactNode;
  renderSubagent: (entry: TranscriptSubagentEntry) => ReactNode;
  renderTool: (entry: TranscriptToolEntry) => ReactNode;
};

/**
 * Render transcript entries as list rows. Only the rows near the viewport
 * mount. These rows also stay mounted, because the scroll owner and the
 * page find them in the DOM: the row that holds the reader's place, the
 * "New" marker and the row after it, and the rows around `revealSeq`.
 */
function TranscriptEntryList(
  props: TranscriptEntryRenderers &
    TranscriptListPlacement & {
      entries: TranscriptEntry[];
      keyPrefix: string;
      unread?: TranscriptUnreadRange;
    },
) {
  const search = useTranscriptSearch();
  const activityKeys = useRef(new Map<string, string>());
  const [openRows] = useState(() => new Map<string, boolean>());
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
    renderSubagent,
    renderTool,
  } = props;
  const renderEntry = useCallback(
    (entry: TranscriptEntry): ReactNode => {
      if (entry.kind === "subagent") return renderSubagent(entry);
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
      return renderMessage(entry);
    },
    [
      renderAttachmentsDelivered,
      renderContext,
      renderFailure,
      renderMessage,
      renderReasoning,
      renderStructuredEvent,
      renderSubagent,
      renderTool,
    ],
  );

  if (search.active && rows.length === 0) {
    return <EmptyTelemetry>No events match your search.</EmptyTelemetry>;
  }

  return (
    <TranscriptOpenRows value={openRows}>
      <div
        className="relative min-w-0"
        ref={listRef}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <VirtualTranscriptRow
            index={item.index}
            key={item.key}
            measure={virtualizer.measureElement}
            offset={item.start - virtualizer.options.scrollMargin}
            renderEntry={renderEntry}
            row={rows[item.index]!}
          />
        ))}
      </div>
    </TranscriptOpenRows>
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
  index: number;
  measure: (element: HTMLElement | null) => void;
  offset: number;
  renderEntry: (entry: TranscriptEntry) => ReactNode;
  row: TranscriptListRow;
}) {
  const { row } = props;
  return (
    <div
      className="absolute left-0 top-0 w-full"
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
            openKey={row.key}
            renderEntry={props.renderEntry}
          />
        </TranscriptRow>
      ) : (
        <TranscriptRow anchorKey={row.key} seq={row.seq}>
          {props.renderEntry(row.entry)}
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
  },
) {
  return (
    <TranscriptEntryList
      entries={groupTranscriptMessages(props.messages)}
      key={props.conversation.conversationId}
      keyPrefix={`${props.conversation.conversationId}:redacted`}
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
      renderMessage={(entry) =>
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
            <TranscriptEventView message={entry.message} openKey={entry.key} />
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
