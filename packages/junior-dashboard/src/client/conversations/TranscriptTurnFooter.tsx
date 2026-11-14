import type { ReactNode } from "react";

import { useConversationMemoryState } from "./conversationMemory";
import {
  TranscriptMemoryChips,
  turnMemoryChips,
} from "./TranscriptMemoryPopover";
import type { TranscriptTurnFooter } from "./transcriptListRows";

/**
 * Show what a Turn left under its reply: its memories, then its Tasks.
 * `tasks` is the rendered Tasks line.
 */
export function TranscriptTurnFooterView(props: {
  footer: TranscriptTurnFooter;
  /** The history is redacted, so memories show only their titles. */
  redacted?: boolean | undefined;
  tasks: ReactNode;
}) {
  const memoryState = useConversationMemoryState();
  // A redacted history keeps memory text out, so its chips open nothing.
  const state = props.redacted ? undefined : memoryState;
  const chips = turnMemoryChips(props.footer, state?.list);
  const hasTasks = props.footer.tasks.length > 0;
  if (chips.length === 0 && !hasTasks) return null;
  return (
    <div className="grid min-w-0 gap-1.5">
      {chips.length > 0 ? (
        <TranscriptMemoryChips chips={chips} state={state} />
      ) : null}
      {hasTasks ? props.tasks : null}
    </div>
  );
}
