import { useMemo, useRef, type Ref } from "react";
import { Lock } from "lucide-react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import type { ConversationData } from "./queries";
import type { ConversationComposerHandle } from "./ConversationComposer";
import { committedMessageIds } from "./conversationOutbox";
import { ComposerDock } from "./ComposerDock";
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
  /** The message box's hint when it is empty. */
  placeholder?: string | undefined;
  ref: Ref<Pick<ConversationComposerHandle, "appendText" | "focus">>;
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
  // Invite subscribes a person to a public Conversation and grants no
  // access, so a private one has none. An archived one is in no feed. The
  // API checks again.
  const data = detail.data;
  const composerConversation = useMemo(
    () => ({
      conversationId: props.conversationId,
      invite:
        data?.visibility === "public" &&
        data.kind !== "task" &&
        !data.archivedAt,
    }),
    [props.conversationId, data?.visibility, data?.kind, data?.archivedAt],
  );

  if (!detail.data) return null;
  return (
    <ConversationReplyFooter
      authors={detail.data.authors}
      conversationId={props.conversationId}
      // Only pass committed ids for mailbox de-dupe. The full transcript is
      // too large to re-enter the footer on every live poll while typing.
      committedMessageIds={mailboxCommittedIds}
      focusRequest={props.focusRequest}
      conversation={composerConversation}
      onFocusRequestDone={props.onFocusRequestDone}
      onPinRequest={props.onPinRequest}
      onShowQuestion={props.onShowQuestion}
      pendingAuthorization={detail.pendingAuthorization}
      // Keep the cancel watermark off props. Live polls refresh generatedAt
      // every 2s; a prop would bust footer memo while the reader types.
      pendingGeneratedAtRef={pendingGeneratedAtRef}
      pendingMessages={detail.pendingMessages}
      placeholder={props.placeholder}
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

/**
 * Take the place of the composer when the reader may not post, so the
 * transcript does not just end without a reason.
 */
export function ConversationReadOnlyDock() {
  return (
    <ComposerDock>
      <p className="m-0 flex items-center justify-center gap-1.5 rounded-lg border border-dashboard-border px-3 py-2.5 text-center text-xs text-dashboard-text-muted">
        <Lock
          aria-hidden="true"
          className="shrink-0"
          size={12}
          strokeWidth={2}
        />
        Only participants can reply to a private conversation.
      </p>
    </ComposerDock>
  );
}
