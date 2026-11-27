import type { ComponentProps } from "react";

import { useDashboardCoreData } from "../../api";
import {
  ConversationJoinDock,
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
    joining: boolean;
    /** Focus or a click in the composer counts as reading. */
    onEngage(): void;
    onJoin(): void;
    view: TranscriptViewMode;
  },
) {
  const { canReply, joining, onEngage, onJoin, view, ...dock } = props;
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
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
    // The detail offers Join only on a public root, to a reader who is not
    // a Participant (`subscribed: false`).
    if (data.subscribed === false) {
      return <ConversationJoinDock joining={joining} onJoin={onJoin} />;
    }
    // The person who started a Conversation is a Participant until they
    // Leave. In a private one, only an Invite brings them back.
    const left =
      viewerEmail !== undefined &&
      data.actorIdentity?.email?.toLowerCase() === viewerEmail.toLowerCase();
    return (
      <ConversationReadOnlyDock
        notice={
          data.visibility === "public"
            ? "Join the conversation this one started from to reply."
            : left
              ? "You left this conversation. A participant can invite you back."
              : "Only participants can reply to a private conversation."
        }
      />
    );
  }
  return null;
}
