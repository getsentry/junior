import { useState, type ReactNode } from "react";
import { ArrowDownToLine } from "lucide-react";

import type { ConversationTurn } from "../types";
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

/** Render ordered conversation transcript segments as message and tool events. */
export function Transcript(props: {
  actions?: ReactNode;
  live?: boolean;
  turns: ConversationTurn[];
}) {
  const [view, setView] = useState<TranscriptViewMode>("rich");
  const hasRedactedTurns = props.turns.some((turn) => turn.transcriptRedacted);
  const bottomPinning = usePinnedTranscriptBottom({
    enabled: props.live ?? false,
    version: transcriptBottomVersion(props.turns),
  });

  if (props.turns.length === 0) {
    return (
      <div className={transcriptEmptyClass()}>
        No transcript is available for this conversation.
      </div>
    );
  }

  return (
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
      {props.turns.map((turn) => (
        <ConversationTranscriptSegment key={turn.id} turn={turn} view={view} />
      ))}
      <div aria-hidden="true" className="h-px" ref={bottomPinning.anchorRef} />
      <JumpToLatestButton
        hasPendingUpdate={bottomPinning.hasPendingUpdate}
        onClick={bottomPinning.jumpToBottom}
        visible={bottomPinning.showJumpToLatest}
      />
    </div>
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
