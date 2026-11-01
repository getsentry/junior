import { memo, useMemo, useRef, type ReactNode } from "react";
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
import {
  isCollapsibleActivityEntry,
  TranscriptActivityGroup,
} from "./TranscriptActivityGroup";
import { TranscriptToolView } from "./TranscriptToolView";
import { TranscriptReasoningView } from "./TranscriptReasoningView";
import { TranscriptAttachmentsDeliveredView } from "./TranscriptAttachmentsDeliveredView";
import { TranscriptStructuredEventView } from "./TranscriptStructuredEventView";
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
import {
  groupTranscriptMessages,
  type RenderedTranscriptEntry,
} from "./transcriptRenderModel";
import { entryMatchesSearch, useTranscriptSearch } from "./transcriptSearch";
import {
  TranscriptRow,
  TranscriptRows,
  TranscriptUnreadMarker,
} from "./TranscriptRows";
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
    <TranscriptReasoningView part={entry.part} timestamp={entry.timestamp} />
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
        <section className="min-w-0 pt-1">
          <SegmentEvents
            onOpenSubagentTranscript={props.onOpenSubagentTranscript}
            conversation={props.conversation}
            messages={messages}
            responding={props.responding}
            unread={props.unread}
          />
        </section>
      </TranscriptTimestampProvider>
    );
  },
);

function SegmentEvents(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
  messages: TranscriptViewMessage[];
  responding?: boolean;
  unread?: TranscriptUnreadRange;
}) {
  return (
    <TranscriptRows>
      {props.conversation.eventHistory.status === "expired" ? (
        <ExpiredTranscriptView
          brief={props.conversation.brief}
          expiredAt={props.conversation.eventHistory.expiredAt}
        />
      ) : props.conversation.eventHistory.status === "available" ? (
        <VisibleTranscriptEntries
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          transcript={props.messages}
          conversation={props.conversation}
          unread={props.unread}
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

const VisibleTranscriptEntries = memo(function VisibleTranscriptEntries(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  transcript: TranscriptViewMessage[];
  conversation: ConversationTranscript;
  unread?: TranscriptUnreadRange;
}) {
  const entries = useMemo(
    () => groupTranscriptMessages(props.transcript),
    [props.transcript],
  );
  return (
    <TranscriptEntryList
      entries={entries}
      keyPrefix={props.conversation.conversationId}
      unread={props.unread}
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
            <TranscriptEventView message={entry.message} />
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
});

function TranscriptEntryList(props: {
  entries: TranscriptEntry[];
  keyPrefix: string;
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
  unread?: TranscriptUnreadRange;
}) {
  const search = useTranscriptSearch();
  const activityKeys = useRef(new Map<string, string>());
  const claimedActivityKeys = new Set<string>();
  const rows: ReactNode[] = [];
  // Search results are not a reading order, so they get no marker.
  const unread = search.active ? undefined : props.unread;
  let unreadMarkerPending = unread !== undefined;
  const isUnread = (seq: number | undefined) =>
    unread !== undefined &&
    seq !== undefined &&
    seq > unread.afterSeq &&
    seq <= unread.throughSeq;
  const pushRow = (unreadRow: boolean, row: ReactNode) => {
    if (unreadMarkerPending && unreadRow) {
      unreadMarkerPending = false;
      rows.push(<TranscriptUnreadMarker key="unread-marker" />);
    }
    rows.push(row);
  };

  const renderEntry = (entry: TranscriptEntry): ReactNode => {
    if (entry.kind === "subagent") return props.renderSubagent(entry);
    if (entry.kind === "context") return props.renderContext(entry);
    if (entry.kind === "attachments_delivered") {
      return props.renderAttachmentsDelivered(entry);
    }
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
        const lastSeq = lastEntrySeq(activityEntries);
        // The marker goes before the group when any of it is unread.
        pushRow(
          activityEntries.some((candidate) => isUnread(candidate.seq)),
          <TranscriptRow
            anchorKey={activityKey}
            indent
            key={activityKey}
            seq={lastSeq}
          >
            <TranscriptActivityGroup
              entries={visibleEntries}
              renderEntry={renderEntry}
            />
          </TranscriptRow>,
        );
      }
      continue;
    }

    if (!search.active || entryMatchesSearch(entry, search.normalizedQuery)) {
      const rowKey = `${props.keyPrefix}:${entry.key}`;
      pushRow(
        isUnread(entry.seq),
        <TranscriptRow anchorKey={rowKey} key={rowKey} seq={entry.seq}>
          {renderEntry(entry)}
        </TranscriptRow>,
      );
    }
    index += 1;
  }

  if (search.active && rows.length === 0) {
    return <EmptyTelemetry>No events match your search.</EmptyTelemetry>;
  }

  // Let rows participate in the parent transcript stack so messages, tool
  // groups, and the thinking indicator share one vertical gap.
  return rows;
}

function lastEntrySeq(
  entries: readonly RenderedTranscriptEntry[],
): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const seq = entries[index]!.seq;
    if (seq !== undefined) return seq;
  }
  return undefined;
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
            <TranscriptEventView message={entry.message} />
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
