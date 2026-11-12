import type { ReactNode } from "react";

import {
  TranscriptTurnMemories,
  useTurnMemoryChips,
} from "./TranscriptMemoryPopover";
import type { TranscriptTurnFooter } from "./transcriptListRows";

/**
 * Show what a Turn left under its reply: its memories, then its Tasks.
 * `tasks` is the rendered Tasks line.
 */
export function TranscriptTurnFooterView(props: {
  footer: TranscriptTurnFooter;
  tasks: ReactNode;
}) {
  const chips = useTurnMemoryChips(props.footer);
  const hasTasks = props.footer.tasks.length > 0;
  if (chips.length === 0 && !hasTasks) return null;
  return (
    <div className="grid min-w-0 gap-1.5">
      {chips.length > 0 ? <TranscriptTurnMemories chips={chips} /> : null}
      {hasTasks ? props.tasks : null}
    </div>
  );
}
