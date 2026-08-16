import { memo, useMemo, useRef, type ReactNode } from "react";

import { unavailableTranscriptLabel } from "../format";
import { conversationTranscriptMessages } from "./eventTranscript";
import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewPart,
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
export const ConversationTranscriptView = memo(function ConversationTranscriptView(props: {
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  conversation: ConversationTranscript;
  responding?: boolean;
  view: TranscriptViewMode;
}) {
  // Rebuild from events, then reuse unchanged message objects so memoized rows
  // can skip work when only the live tail advanced.
  const previousMessagesRef = useRef<TranscriptViewMessage[]>([]);
  const messages = useMemo(() => {
    const next = conversationTranscriptMessages(props.conversation);
    const stable = reuseUnchangedTranscriptMessages(
      previousMessagesRef.current,
      next,
    );
    previousMessagesRef.current = stable;
    return stable;
  }, [props.conversation]);

  return (
    <section className="min-w-0 py-1">
      <div className="min-w-0">
        <SegmentEvents
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.conversation}
          messages={messages}
          view={props.view}
        />
        {props.responding ? <TranscriptTypingIndicator /> : null}
      </div>
    </section>
  );
});

function reuseUnchangedTranscriptMessages(
  previous: readonly TranscriptViewMessage[],
  next: TranscriptViewMessage[],
): TranscriptViewMessage[] {
  if (previous.length === 0) return next;
  if (previous === next) return next;

  const previousByKey = new Map(
    previous.map((message) => [transcriptMessageStableKey(message), message]),
  );
  let changed = previous.length !== next.length;
  const stable = next.map((message) => {
    const prior = previousByKey.get(transcriptMessageStableKey(message));
    if (prior && sameTranscriptMessage(prior, message)) return prior;
    changed = true;
    return message;
  });
  return changed ? stable : previous.slice();
}

function transcriptMessageStableKey(message: TranscriptViewMessage): string {
  return `${message.sourceSeq}:${message.role}:${message.messageId ?? ""}`;
}

function sameTranscriptMessage(
  left: TranscriptViewMessage,
  right: TranscriptViewMessage,
): boolean {
  return (
    left.sourceSeq === right.sourceSeq &&
    left.role === right.role &&
    left.messageId === right.messageId &&
    left.timestamp === right.timestamp &&
    left.outcome === right.outcome &&
    left.pending === right.pending &&
    left.delivery === right.delivery &&
    left.eventType === right.eventType &&
    left.explicitMention === right.explicitMention &&
    left.context === right.context &&
    left.source === right.source &&
    sameJsonValue(left.actorIdentity, right.actorIdentity) &&
    sameJsonValue(left.contexts, right.contexts) &&
    sameJsonValue(left.route, right.route) &&
    sameTranscriptParts(left.parts, right.parts)
  );
}

function sameTranscriptParts(
  left: readonly TranscriptViewPart[],
  right: readonly TranscriptViewPart[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameJsonValue(left[index], right[index])) return false;
  }
  return true;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left == null || right == null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object") return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!sameJsonValue(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
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
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 pt-1">
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
        <TranscriptRailEvent kind="attachments_delivered">
          <TranscriptAttachmentsDeliveredView
            conversation={props.conversation}
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
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
}

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

  return <div className="grid min-w-0 gap-5">{rows}</div>;
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
      renderAttachmentsDelivered={(entry) => (
        <TranscriptRailEvent kind="attachments_delivered">
          <TranscriptAttachmentsDeliveredView
            conversation={props.conversation}
            part={entry.part}
            timestamp={entry.timestamp}
          />
        </TranscriptRailEvent>
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
