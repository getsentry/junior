import { useState, type ReactNode } from "react";

import type { ConversationTurn } from "../types";
import { TranscriptHeader } from "./TranscriptHeader";
import { ConversationTranscriptSegment } from "./TranscriptTurn";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";

/** Render ordered conversation transcript segments as message and tool events. */
export function Transcript(props: {
  actions?: ReactNode;
  turns: ConversationTurn[];
}) {
  const [view, setView] = useState<TranscriptViewMode>("rich");
  const hasRedactedTurns = props.turns.some((turn) => turn.transcriptRedacted);

  if (props.turns.length === 0) {
    return (
      <div className={transcriptEmptyClass()}>
        No transcript is available for this conversation.
      </div>
    );
  }

  return (
    <div className="grid min-w-0">
      <TranscriptHeader
        actions={props.actions}
        redacted={hasRedactedTurns}
        value={view}
        onChange={setView}
      />
      {props.turns.map((turn) => (
        <ConversationTranscriptSegment
          key={turn.id}
          turn={turn}
          view={view}
        />
      ))}
    </div>
  );
}
