import { useMemo, useState, type ReactNode } from "react";
import { ArrowDownToLine, Search } from "lucide-react";

import type { ConversationTurn, TranscriptViewSubagentPart } from "../types";
import { cn } from "../styles";
import { Button } from "./Button";
import { TranscriptHeader } from "./TranscriptHeader";
import { ConversationTranscriptSegment } from "./TranscriptTurn";
import {
  transcriptBottomVersion,
  usePinnedTranscriptBottom,
} from "./transcriptBottomPinning";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";
import { TranscriptSearchProvider, turnHasMatch } from "./transcriptSearch";

/** Render ordered conversation transcript segments as message and tool events. */
export function Transcript(props: {
  actions?: ReactNode;
  live?: boolean;
  onOpenSubagentTranscript?: (args: {
    part: TranscriptViewSubagentPart;
    turn: ConversationTurn;
  }) => void;
  turns: ConversationTurn[];
}) {
  const [view, setView] = useState<TranscriptViewMode>("rich");
  const [search, setSearch] = useState("");

  const normalizedSearch = search.trim().toLowerCase();
  const hasRedactedTurns = props.turns.some((turn) => turn.transcriptRedacted);
  const bottomPinning = usePinnedTranscriptBottom({
    enabled: props.live ?? false,
    version: transcriptBottomVersion(props.turns),
  });

  const visibleTurns = useMemo(
    () =>
      normalizedSearch
        ? props.turns.filter((turn) => turnHasMatch(turn, normalizedSearch))
        : props.turns,
    [props.turns, normalizedSearch],
  );

  if (props.turns.length === 0) {
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
          redacted={hasRedactedTurns}
          value={view}
          onChange={setView}
        />
        <div className="relative mb-4 mt-2">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555]"
            size={13}
            strokeWidth={2.5}
          />
          <input
            aria-label="Search transcript"
            className="h-8 w-full rounded-md border border-[#beaaff]/20 bg-white/[0.04] pl-8 pr-3 text-[0.82rem] text-[#d6d6d6] outline-none placeholder:text-[#555] focus:border-[#beaaff]/40 focus:ring-1 focus:ring-[#beaaff]/20"
            placeholder="Search transcript…"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        {visibleTurns.length > 0 ? (
          visibleTurns.map((turn) => (
            <ConversationTranscriptSegment
              key={turn.id}
              onOpenSubagentTranscript={props.onOpenSubagentTranscript}
              turn={turn}
              view={view}
            />
          ))
        ) : normalizedSearch ? (
          <div className={transcriptEmptyClass()}>
            No events match your search.
          </div>
        ) : null}
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
        className="relative border-[#beaaff]/45 bg-[#111] shadow-[0_6px_24px_rgba(0,0,0,0.36)] hover:border-[#d8ccff]/70"
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
