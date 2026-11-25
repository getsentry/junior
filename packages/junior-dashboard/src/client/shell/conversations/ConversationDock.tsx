import type { ComponentProps, ReactNode } from "react";

import { ComposerDock } from "../../conversations/ComposerDock";
import {
  ConversationPageDock,
  ConversationReadOnlyDock,
} from "../../conversations/ConversationPageDock";
import type { TranscriptViewMode } from "../../conversations/transcriptRenderModel";
import { useSpaceData } from "../../spaces/queries";
import { JoinSpaceButton } from "../../spaces/SpaceActions";

/**
 * Show the reply composer under the transcript, or say why the reader may
 * not reply. The page decides who may reply. Only a member of an active
 * Space sends its Lead messages, so a Lead asks others to join first.
 */
export function ConversationDock(
  props: ComponentProps<typeof ConversationPageDock> & {
    canReply: boolean;
    lead: boolean;
    /** Focus or a click in the composer counts as reading. */
    onEngage(): void;
    /** The Conversation's Space, which a Lead's dock reads. */
    spaceId: string | undefined;
    view: TranscriptViewMode;
  },
) {
  const { canReply, lead, onEngage, spaceId, view, ...dock } = props;
  const space = useSpaceData(lead ? spaceId : undefined).data;
  if (lead && view === "rich") {
    if (!space) return null;
    if (!space.viewerIsMember) {
      return (
        <LeadDockNotice>
          Join {space.name} to message its Lead.
          <JoinSpaceButton space={space} />
        </LeadDockNotice>
      );
    }
    if (space.archivedAt) {
      return (
        <LeadDockNotice>
          This Space is archived. Restore it to message its Lead.
        </LeadDockNotice>
      );
    }
  }
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

function LeadDockNotice(props: { children: ReactNode }) {
  return (
    <ComposerDock>
      <div className="flex items-center justify-center gap-3 rounded-lg border border-dashboard-border px-3 py-2 text-center text-xs text-dashboard-text-muted">
        {props.children}
      </div>
    </ComposerDock>
  );
}
