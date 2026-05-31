import { useState } from "react";

import type { ConversationTurn } from "../types";
import { TranscriptHeader } from "./TranscriptHeader";
import { TurnTranscript } from "./TranscriptTurn";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";

/** Render ordered conversation turns as message, thinking, and tool-call events. */
export function Transcript(props: { turns: ConversationTurn[] }) {
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
        redacted={hasRedactedTurns}
        value={view}
        onChange={setView}
      />
      {props.turns.map((turn, index) => (
        <TurnTranscript
          key={turn.id}
          number={index + 1}
          turn={turn}
          view={view}
        />
      ))}
    </div>
  );
}
