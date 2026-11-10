import { useMemo, useState, type ReactNode, type Ref } from "react";
import type { ConversationMailboxMessage } from "./conversationOutbox";
import { ArrowDown } from "lucide-react";

import type {
  ConversationTranscript,
  TranscriptViewSubagentPart,
} from "../types";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { Button } from "../components/ui/button";
import { cn } from "../styles";
import {
  ConversationTranscriptView,
  TranscriptAskRevealContext,
  type TranscriptAskReveal,
} from "./ConversationTranscript";
import { ConversationEventLog } from "./ConversationEventLog";
import {
  TranscriptJumpToLatestContext,
  transcriptBottomVersion,
  transcriptJuniorMessageVersion,
  useAutoLoadHistoryPage,
  usePinnedTranscriptBottom,
} from "./transcriptBottomPinning";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import {
  useTranscriptReadReporter,
  type TranscriptUnreadRange,
} from "./transcriptReadPosition";
import { TranscriptSearchProvider } from "./transcriptSearch";
import type { TranscriptHistory } from "./transcriptAroundHistory";
import {
  TurnContextPanelProvider,
  type TurnContextPanel,
} from "./TranscriptTurnContextView";

/** Render one conversation transcript as ordered message and tool events. */
export function Transcript(props: {
  hasPreviousPage?: boolean;
  historyError?: Error | null;
  historyVersion?: string;
  live?: boolean;
  /** The stored read position of the viewer. */
  lastReadSeq?: number;
  loadingPreviousPage?: boolean;
  /**
   * Newer pages between the read position and the latest. They load on
   * scroll. Jump to latest skips them.
   */
  newerHistory?: TranscriptHistory["newer"];
  pinRequestVersion?: number;
  onLoadPreviousPage?: () => void;
  /** Receive the last event sequence the reader saw in the transcript. */
  onRead?: (seq: number) => void;
  /** The reader acted outside the transcript, such as in the composer. */
  readEngaged?: boolean;
  onSelectedEventSeqChange?(seq: number | undefined): void;
  /** The reader's own sends to show at the end until history has them. */
  pendingMessages?: readonly ConversationMailboxMessage[];
  responding?: boolean;
  /** Show the row of the question that docks above the message box. */
  revealAsk?: TranscriptAskReveal;
  /** Keep the rows around this event seq mounted, so the page can show it. */
  revealSeq?: number;
  search?: string;
  onSearchChange?(value: string): void;
  /** Index of the current search match. */
  searchMatch?: number;
  onSearchMatches?(count: number, prepended: number): void;
  selectedEventSeq?: number;
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  transcript?: ConversationTranscript;
  /** Show turn context in the owner's panel. Without it, a drawer opens. */
  turnContextPanel?: TurnContextPanel;
  /** Open where a link shows its row instead of the latest message. */
  startAtLink?: boolean;
  /** Open at the "New" marker instead of the latest message. */
  startAtUnread?: boolean;
  /** Rows that were unread when the Conversation opened get a marker. */
  unread?: TranscriptUnreadRange;
  view?: TranscriptViewMode;
}) {
  const view = props.view ?? "rich";
  const [localSearch, setLocalSearch] = useState("");
  const search = props.search ?? localSearch;
  const historyLabel = view === "raw" ? "events" : "messages";
  const redacted = props.transcript?.eventHistory.status === "redacted";
  const bottomPinning = usePinnedTranscriptBottom({
    conversationId: props.transcript?.conversationId,
    enabled: props.live ?? false,
    endsAtLatest: !props.newerHistory,
    historyVersion: props.historyVersion ?? "empty",
    juniorMessageVersion: transcriptJuniorMessageVersion(props.transcript),
    pinRequestVersion: props.pinRequestVersion,
    startAtLink: props.startAtLink,
    startAtUnread: view === "rich" && props.startAtUnread,
    view,
    versions: {
      rich: transcriptBottomVersion(props.transcript, "rich"),
      raw: transcriptBottomVersion(props.transcript, "raw"),
    },
  });

  const { revealAsk } = props;
  const { showRow } = bottomPinning;
  const askReveal = useMemo(
    () => (revealAsk ? { ...revealAsk, showRow } : undefined),
    [revealAsk, showRow],
  );

  // Read positions follow the transcript rows, not the event log. Search
  // results skip rows, so they do not move the read position.
  useTranscriptReadReporter({
    content: bottomPinning.contentElement,
    engaged: props.readEngaged,
    lastReadSeq: props.lastReadSeq,
    onRead: props.onRead,
    paused: view !== "rich" || search.trim().length > 0,
  });
  const loadPreviousPage = () => props.onLoadPreviousPage?.();
  const previousPageRef = useAutoLoadHistoryPage({
    edge: "top",
    enabled: Boolean(
      props.onLoadPreviousPage &&
      props.hasPreviousPage &&
      !props.loadingPreviousPage &&
      !props.historyError,
    ),
    historyVersion: props.historyVersion ?? "empty",
    onLoad: loadPreviousPage,
  });
  const newer = props.newerHistory;
  const newerPageRef = useAutoLoadHistoryPage({
    edge: "bottom",
    enabled: Boolean(newer && !newer.loading && !newer.error),
    historyVersion: props.historyVersion ?? "empty",
    onLoad: () => newer?.load(),
  });
  const jumpToLatest = () => {
    // The latest page is in the detail, so the jump needs no request.
    newer?.showLatest();
    bottomPinning.jumpToBottom();
  };

  if (!props.transcript) {
    return (
      <EmptyTelemetry>
        No transcript is available for this conversation.
      </EmptyTelemetry>
    );
  }

  return (
    <TranscriptSearchProvider
      match={props.searchMatch}
      onMatches={props.onSearchMatches}
      query={search}
    >
      {/* The pinning hook holds the reader's place; browser anchoring would fight it. */}
      <div
        className="grid min-w-0 [overflow-anchor:none]"
        ref={bottomPinning.contentRef}
      >
        {redacted ? (
          <div className="mb-2 min-w-0 break-words text-sm leading-relaxed text-dashboard-text-muted">
            Hidden because this conversation is not public.
          </div>
        ) : null}
        {props.hasPreviousPage || props.loadingPreviousPage ? (
          <HistoryPageControl
            className="mb-3"
            label="Load earlier events"
            loading={props.loadingPreviousPage}
            onClick={loadPreviousPage}
            ref={previousPageRef}
          >
            {props.loadingPreviousPage
              ? `Loading earlier ${historyLabel}…`
              : `Show earlier ${historyLabel}`}
          </HistoryPageControl>
        ) : null}
        {props.historyError ? (
          <div
            aria-live="polite"
            className="mb-2 text-center font-sans text-xs text-amber-100/65"
          >
            Earlier events could not be loaded.
          </div>
        ) : null}
        {view === "raw" ? (
          <ConversationEventLog
            key={props.transcript.conversationId}
            conversation={props.transcript}
            onSearchChange={props.onSearchChange ?? setLocalSearch}
            onSelectedSeqChange={props.onSelectedEventSeqChange}
            scrollAnchorKey={bottomPinning.scrollAnchorKey}
            selectedSeq={props.selectedEventSeq}
          />
        ) : (
          <TurnContextPanelProvider panel={props.turnContextPanel}>
            <TranscriptJumpToLatestContext value={jumpToLatest}>
              <TranscriptAskRevealContext value={askReveal}>
                <ConversationTranscriptView
                  onOpenSubagentTranscript={props.onOpenSubagentTranscript}
                  conversation={props.transcript}
                  pendingMessages={props.pendingMessages}
                  responding={props.responding ?? props.live ?? false}
                  revealSeq={props.revealSeq}
                  scrollAnchorKey={bottomPinning.scrollAnchorKey}
                  unread={props.unread}
                />
              </TranscriptAskRevealContext>
            </TranscriptJumpToLatestContext>
          </TurnContextPanelProvider>
        )}
        {newer ? (
          <>
            {newer.error ? (
              <div
                aria-live="polite"
                className="mt-2 text-center font-sans text-xs text-amber-100/65"
              >
                Newer events could not be loaded.
              </div>
            ) : null}
            {/* The bottom margin keeps the jump control off this row. */}
            <HistoryPageControl
              className="mb-12 mt-3"
              label="Load newer events"
              loading={newer.loading}
              onClick={newer.load}
              ref={newerPageRef}
            >
              {newer.loading
                ? `Loading newer ${historyLabel}…`
                : `Show newer ${historyLabel}`}
            </HistoryPageControl>
          </>
        ) : null}
        <div
          aria-hidden="true"
          className="h-px"
          ref={bottomPinning.anchorRef}
        />
        <JumpToLatestButton
          hasPendingUpdate={bottomPinning.hasPendingUpdate}
          onClick={jumpToLatest}
          visible={bottomPinning.showJumpToLatest}
        />
      </div>
    </TranscriptSearchProvider>
  );
}

/** A divider with one control that loads another page of history. */
function HistoryPageControl(props: {
  children: ReactNode;
  className: string;
  label: string;
  loading?: boolean;
  onClick: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className={cn("flex items-center gap-3", props.className)}
      ref={props.ref}
    >
      <span className="h-px min-w-4 flex-1 bg-dashboard-fill-strong" />
      <button
        aria-label={props.label}
        className="shrink-0 cursor-pointer border-0 bg-transparent px-1 py-0.5 font-sans text-xs font-medium text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-dashboard-focus/55 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.loading}
        onClick={props.onClick}
        title={props.label}
        type="button"
      >
        {props.children}
      </button>
      <span className="h-px min-w-4 flex-1 bg-dashboard-fill-strong" />
    </div>
  );
}

function JumpToLatestButton(props: {
  hasPendingUpdate: boolean;
  onClick: () => void;
  visible: boolean;
}) {
  if (!props.visible) return null;

  return (
    // Sticky offsets count from inside the scroll region's bottom padding
    // (pb-4 / md:pb-6). The negative offsets cancel most of it, so the pill
    // sits 12px (16px on md) above the composer, centered on the transcript.
    <div className="pointer-events-none sticky -bottom-2.5 z-20 flex h-0 justify-center md:-bottom-5">
      <Button
        aria-label={
          props.hasPendingUpdate ? "Jump to latest update" : "Jump to latest"
        }
        className="pointer-events-auto h-8 -translate-y-full gap-1.5 rounded-full pl-3 pr-3.5 text-xs shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
        onClick={props.onClick}
      >
        <ArrowDown aria-hidden="true" size={14} strokeWidth={2} />
        Jump to latest
      </Button>
    </div>
  );
}
