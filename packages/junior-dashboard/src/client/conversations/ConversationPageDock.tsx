import { useMemo, useRef } from "react";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import type { ConversationData } from "./queries";
import { ConversationReplyFooter } from "./ConversationReplyFooter";
import { conversationIsResponding, isChildConversation } from "./transcript";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { latestReviewItemId } from "../review-desk/reviewItemFormat";

/** Render the reply composer below a Conversation transcript, when the viewer may reply. */
export function ConversationPageDock(props: {
  conversationId: string;
  detail: ConversationData;
  /** True when newer transcript pages are not loaded. */
  hasNewerPage: boolean;
  live: boolean;
  onPinRequest(): void;
  view: TranscriptViewMode;
}) {
  const { detail } = props;
  // Key on the event array, not the whole detail object. Metadata-only polls
  // reuse events via structural sharing, so the footer keeps a stable id list.
  const mailboxCommittedIds = useMemo(
    () => committedMessageIds(detail.data?.events),
    [detail.data?.events],
  );
  const reviewItemId = useMemo(
    () => latestReviewItemId(detail.data?.events),
    [detail.data?.events],
  );
  // Cancel needs the latest mailbox watermark, but not as a render prop. Live
  // polls refresh generatedAt every 2s even when the queue is unchanged.
  const pendingGeneratedAtRef = useRef(detail.pendingGeneratedAt);
  pendingGeneratedAtRef.current = detail.pendingGeneratedAt;

  // A child Conversation takes input only from its parent agent, and it
  // runs without interactive auth, so it has no approval to show.
  if (
    props.view !== "rich" ||
    !detail.data?.isParticipant ||
    isChildConversation(detail.data)
  ) {
    return null;
  }
  return (
    <ConversationReplyFooter
      authors={detail.data.authors}
      conversationId={props.conversationId}
      // Only pass committed ids for mailbox de-dupe. The full transcript is
      // too large to re-enter the footer on every live poll while typing.
      committedMessageIds={mailboxCommittedIds}
      onPinRequest={props.onPinRequest}
      pendingAuthorization={detail.pendingAuthorization}
      // Keep the cancel watermark off props. Live polls refresh generatedAt
      // every 2s; a prop would bust footer memo while the reader types.
      pendingGeneratedAtRef={pendingGeneratedAtRef}
      pendingMessages={detail.pendingMessages}
      reviewItemId={reviewItemId}
      // Without live history, an inline send would never leave the
      // transcript tail. A started Turn reads a new send only later.
      // Keep those sends in the queue. An earlier inline send that
      // history does not have yet can start that Turn first. While
      // newer pages are not loaded, the transcript tail is not the
      // latest event, so a send waits in the queue too.
      sendsInline={
        detail.data.eventHistory.status === "available" &&
        !props.hasNewerPage &&
        !conversationIsResponding(detail.data) &&
        detail.inlineMessages.length === 0
      }
      stoppable={props.live}
    />
  );
}

function committedMessageIds(
  events: ConversationDetailReport["events"] | undefined,
): readonly string[] {
  if (!events) return EMPTY_MESSAGE_IDS;
  const ids: string[] = [];
  for (const event of events) {
    if (event.data.type === "message") ids.push(event.data.messageId);
  }
  return ids;
}

const EMPTY_MESSAGE_IDS: readonly string[] = [];
