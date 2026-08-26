import { memo, useMemo, useRef, type ReactNode } from "react";

import { unavailableTranscriptLabel } from "../format";
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
import { TranscriptResourceEventView } from "./TranscriptResourceEventView";
import { TranscriptTypingIndicator } from "./TranscriptTypingIndicator";
import {
  groupTranscriptMessages,
  type RenderedTranscriptEntry,
  type TranscriptViewMode,
} from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";
import { entryMatchesSearch, useTranscriptSearch } from "./transcriptSearch";
import { TranscriptTimestampProvider } from "./TranscriptTimestamp";

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
    responding?: boolean;
    view: TranscriptViewMode;
  }) {
    // Event arrays stay stable across metadata-only polls. Project the transcript
    // only when event content changes, not when timing metadata refreshes.
    const events = props.conversation.events;
    const messages = useMemo(
      () => transcriptMessagesFromEvents(events),
      [events],
    );

    return (
      <TranscriptTimestampProvider>
        <section className="min-w-0 pt-1">
          <SegmentEvents
            onOpenSubagentTranscript={props.onOpenSubagentTranscript}
            conversation={props.conversation}
            messages={messages}
            responding={props.responding}
            view={props.view}
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
  view: TranscriptViewMode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 md:gap-4">
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
      {props.responding ? <TranscriptTypingIndicator /> : null}
    </div>
  );
}

const VisibleTranscriptEntries = memo(function VisibleTranscriptEntries(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  transcript: TranscriptViewMessage[];
  conversation: ConversationTranscript;
  view: TranscriptViewMode;
}) {
  const entries = useMemo(
    () => groupTranscriptMessages(props.transcript),
    [props.transcript],
  );
  return (
    <TranscriptEntryList
      entries={entries}
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
          failureCode={entry.failureCode}
          failureReason={entry.failureReason}
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
        <TranscriptToolView
          part={entry.part}
          timestamp={entry.timestamp}
          view={props.view}
        />
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
}) {
  const search = useTranscriptSearch();
  const activityKeys = useRef(new Map<string, string>());
  const claimedActivityKeys = new Set<string>();
  const rows: ReactNode[] = [];

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
        rows.push(
          <div className="mobile-transcript-row" key={activityKey}>
            <TranscriptActivityGroup
              entries={visibleEntries}
              renderEntry={renderEntry}
            />
          </div>,
        );
      }
      continue;
    }

    if (!search.active || entryMatchesSearch(entry, search.normalizedQuery)) {
      rows.push(
        <div
          className="mobile-transcript-row"
          key={`${props.keyPrefix}:${entry.key}`}
        >
          {renderEntry(entry)}
        </div>,
      );
    }
    index += 1;
  }

  if (search.active && rows.length === 0) {
    return (
      <div className={transcriptEmptyClass()}>No events match your search.</div>
    );
  }

  // Let rows participate in the parent transcript stack so messages, tool
  // groups, and the thinking indicator share one vertical gap.
  return rows;
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
          failureCode={entry.failureCode}
          failureReason={entry.failureReason}
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
