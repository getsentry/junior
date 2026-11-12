import { useMemo, useRef, type Ref } from "react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import type { ConversationData } from "./queries";
import type { ConversationComposerHandle } from "./ConversationComposer";
import { committedMessageIds } from "./conversationOutbox";
import {
  ConversationReplyFooter,
  type ReplyFocusRequest,
} from "./ConversationReplyFooter";
import { conversationIsResponding } from "./transcript";

/** Render the reply composer under the transcript. The page decides who may reply. */
export function ConversationPageDock(props: {
  conversationId: string;
  detail: ConversationData;
  focusRequest?: ReplyFocusRequest;
  /** True when newer transcript pages are not loaded. */
  hasNewerPage: boolean;
  live: boolean;
  onFocusRequestDone(key: string): void;
  onPinRequest(): void;
  onShowQuestion(item: ReviewItemPayload, arrived: boolean): void;
  ref: Ref<Pick<ConversationComposerHandle, "appendText">>;
}) {
  const { detail } = props;
  // Key on the event array, not the whole detail object. Metadata-only polls
  // reuse events via structural sharing, so the footer keeps a stable id list.
  const mailboxCommittedIds = useMemo(
    () => committedMessageIds(detail.data?.events),
    [detail.data?.events],
  );
  // Cancel needs the latest mailbox watermark, but not as a render prop. Live
  // polls refresh generatedAt every 2s even when the queue is unchanged.
  const pendingGeneratedAtRef = useRef(detail.pendingGeneratedAt);
  pendingGeneratedAtRef.current = detail.pendingGeneratedAt;

  if (!detail.data) return null;
  return (
    <ConversationReplyFooter
      authors={detail.data.authors}
      conversationId={props.conversationId}
      // Only pass committed ids for mailbox de-dupe. The full transcript is
      // too large to re-enter the footer on every live poll while typing.
      committedMessageIds={mailboxCommittedIds}
      focusRequest={props.focusRequest}
      onFocusRequestDone={props.onFocusRequestDone}
      onPinRequest={props.onPinRequest}
      onShowQuestion={props.onShowQuestion}
      pendingAuthorization={detail.pendingAuthorization}
      // Keep the cancel watermark off props. Live polls refresh generatedAt
      // every 2s; a prop would bust footer memo while the reader types.
      pendingGeneratedAtRef={pendingGeneratedAtRef}
      pendingMessages={detail.pendingMessages}
      ref={props.ref}
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
