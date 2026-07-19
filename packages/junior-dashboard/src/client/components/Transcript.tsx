import { useState, type ReactNode } from "react";
import { ArrowDownToLine, Search } from "lucide-react";

import type {
  ConversationTranscript,
  TranscriptViewSubagentPart,
} from "../types";
import { cn } from "../styles";
import { Button } from "./Button";
import { TranscriptHeader } from "./TranscriptHeader";
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
  actions?: ReactNode;
  live?: boolean;
  responding?: boolean;
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    conversation: ConversationTranscript;
  }) => void;
  transcript?: ConversationTranscript;
}) {
  const [view, setView] = useState<TranscriptViewMode>("rich");
  const [search, setSearch] = useState("");

  const redacted = Boolean(props.transcript?.transcriptRedacted);
  const bottomPinning = usePinnedTranscriptBottom({
    enabled: props.live ?? false,
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
      <div
        className={cn("grid min-w-0", props.live && "max-sm:pr-12")}
        ref={bottomPinning.contentRef}
      >
        <TranscriptHeader
          actions={props.actions}
          redacted={redacted}
          value={view}
          onChange={setView}
        />
        <div className="relative mb-5 mt-3">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/25"
            size={13}
            strokeWidth={2.5}
          />
          <input
            aria-label="Search transcript"
            className="h-10 w-full rounded-lg border border-white/[0.08] bg-black/20 pl-9 pr-3 font-mono text-[0.74rem] text-white/75 outline-none transition-colors placeholder:text-white/20 hover:border-white/15 focus:border-cyan-300/35 focus:ring-2 focus:ring-cyan-300/10"
            placeholder="Search transcript…"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
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
    <div className="fixed bottom-4 right-4 z-20 md:bottom-6 md:right-8">
      <Button
        aria-label={label}
        className="relative rounded-lg border-cyan-300/30 bg-[#0b181a] shadow-[0_6px_24px_rgba(0,0,0,0.36)] hover:border-cyan-200/60"
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
