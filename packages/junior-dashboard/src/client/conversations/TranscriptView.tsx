import { ArrowDownToLine } from "lucide-react";

import type {
  ConversationTranscript,
  TranscriptViewSubagentPart,
} from "../types";
import { Button } from "../components/Button";
import { ConversationTranscriptView } from "./ConversationTranscript";
import {
  transcriptBottomVersion,
  usePinnedTranscriptBottom,
} from "./transcriptBottomPinning";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";
import { TranscriptSearchProvider } from "./transcriptSearch";

/** Render one conversation transcript as ordered message and tool events. */
export function Transcript(props: {
  hasPreviousPage?: boolean;
  historyError?: Error | null;
  historyVersion?: string;
  live?: boolean;
  loadingPreviousPage?: boolean;
  onLoadPreviousPage?: () => void;
  responding?: boolean;
  search?: string;
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  transcript?: ConversationTranscript;
  view?: TranscriptViewMode;
}) {
  const view = props.view ?? "rich";
  const search = props.search ?? "";
  const redacted = props.transcript?.eventHistory.status === "redacted";
  const bottomPinning = usePinnedTranscriptBottom({
    conversationId: props.transcript?.conversationId,
    enabled: props.live ?? false,
    historyVersion: props.historyVersion ?? "empty",
    loadingPreviousPage: props.loadingPreviousPage ?? false,
    version: transcriptBottomVersion(props.transcript),
  });

  if (!props.transcript) {
    return (
      <div className={transcriptEmptyClass()}>
        No transcript is available for this conversation.
      </div>
    );
  }

  return (
    <TranscriptSearchProvider query={search}>
      <div className="grid min-w-0" ref={bottomPinning.contentRef}>
        {redacted ? (
          <div className="mb-2 min-w-0 break-words text-sm leading-relaxed text-dashboard-text-muted">
            Hidden because this conversation is not public.
          </div>
        ) : null}
        {props.hasPreviousPage || props.loadingPreviousPage ? (
          <div className="mb-3 flex items-center gap-3">
            <span className="h-px min-w-4 flex-1 bg-dashboard-fill-strong" />
            <button
              aria-label="Load earlier events"
              className="shrink-0 cursor-pointer border-0 bg-transparent px-1 py-0.5 font-sans text-xs font-medium text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={props.loadingPreviousPage}
              onClick={() => {
                bottomPinning.preserveViewportForPrepend();
                props.onLoadPreviousPage?.();
              }}
              title="Load earlier events"
              type="button"
            >
              {props.loadingPreviousPage
                ? "Loading earlier messages…"
                : "Show earlier messages"}
            </button>
            <span className="h-px min-w-4 flex-1 bg-dashboard-fill-strong" />
          </div>
        ) : null}
        {props.historyError ? (
          <div
            aria-live="polite"
            className="mb-2 text-center font-sans text-xs text-amber-100/65"
          >
            Earlier events could not be loaded.
          </div>
        ) : null}
        <ConversationTranscriptView
          onOpenSubagentTranscript={props.onOpenSubagentTranscript}
          conversation={props.transcript}
          responding={props.responding ?? props.live ?? false}
          view={view}
        />
        <div
          aria-hidden="true"
          className="h-px"
          ref={bottomPinning.anchorRef}
        />
        <JumpToLatestButton
          hasPendingUpdate={bottomPinning.hasPendingUpdate}
          onClick={bottomPinning.jumpToBottom}
          visible={bottomPinning.showJumpToLatest}
        />
      </div>
    </TranscriptSearchProvider>
  );
}

function JumpToLatestButton(props: {
  hasPendingUpdate: boolean;
  onClick: () => void;
  visible: boolean;
}) {
  if (!props.visible) return null;

  const label = props.hasPendingUpdate
    ? "Jump to latest update"
    : "Jump to latest";

  return (
    <div className="pointer-events-none sticky bottom-3 z-20 mt-3 flex justify-center px-3 md:fixed md:inset-x-auto md:bottom-6 md:right-8 md:mt-0 md:justify-end md:px-0">
      <Button
        aria-label={label}
        className="pointer-events-auto relative rounded-lg !border !border-cyan-300/30 !bg-dashboard-jump-idle text-dashboard-text shadow-[0_6px_24px_var(--color-dashboard-shadow-jump)] hover:!border-cyan-200/60 hover:!bg-dashboard-jump-hover hover:!text-dashboard-text"
        onClick={props.onClick}
        size="icon"
        title={label}
      >
        <ArrowDownToLine aria-hidden="true" size={16} strokeWidth={2} />
        {props.hasPendingUpdate ? (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 size-2 bg-emerald-300"
          />
        ) : null}
      </Button>
    </div>
  );
}
