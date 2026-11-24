import type { ComponentProps } from "react";

import {
  ConversationPageDock,
  ConversationReadOnlyDock,
} from "../../conversations/ConversationPageDock";
import type { TranscriptViewMode } from "../../conversations/transcriptRenderModel";

/**
 * Show the reply composer under the transcript, or say why the reader may
 * not reply. The page decides who may reply.
 */
export function ConversationDock(
  props: ComponentProps<typeof ConversationPageDock> & {
    canReply: boolean;
    /** Focus or a click in the composer counts as reading. */
    onEngage(): void;
    view: TranscriptViewMode;
  },
) {
  const { canReply, onEngage, view, ...dock } = props;
  if (canReply) {
    return (
      <div
        className="contents"
        onFocusCapture={onEngage}
        onPointerDownCapture={onEngage}
      >
        <ConversationPageDock {...dock} />
      </div>
    );
  }
  // A Task takes input only from its parent agent, so it gets no notice.
  // The event log has no composer either way.
  const data = dock.detail.data;
  if (view === "rich" && data && data.kind !== "task") {
    return <ConversationReadOnlyDock />;
  }
  return null;
}
