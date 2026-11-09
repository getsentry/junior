import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type {
  ConversationDetailReport,
  ConversationPendingMessagesReport,
  InputImage,
} from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import { useReviewItemData } from "../review-desk/queries";
import { reviewItemWaitsForAnswer } from "../review-desk/reviewItemFormat";
import { useConfirmUnsentAnswers } from "../review-desk/UnsentAnswers";
import { readStoredComposerImages } from "./ComposerImages";
import { ComposerDock } from "./ComposerDock";
import {
  ConversationComposer,
  restoreStoredDraftText,
  touchKeyboardMatches,
  type ConversationComposerHandle,
} from "./ConversationComposer";
import type { ConversationMailboxMessage } from "./conversationOutbox";
import { PendingAuthorization } from "./ConversationMeta";
import { PendingMailboxStack } from "./PendingMailboxStack";
import {
  useAppendConversationMessage,
  useCancelConversationPendingMessages,
  useSteerConversationPendingMessages,
  useStopConversationTurn,
} from "./queries";
import { MOBILE_LAYOUT_QUERY } from "../layoutMedia";

/**
 * Own mutation state and mailbox chrome outside the page tree that re-renders
 * on every live transcript poll. Keeps composer props stable while typing.
 *
 * Memoized so metadata-only polls that keep mailbox identity stable skip the
 * footer tree. Fast chat UIs isolate the composer the same way.
 */
export const ConversationReplyFooter = memo(ReplyFooter);

function ReplyFooter(props: {
  authors?: ConversationDetailReport["authors"];
  committedMessageIds: readonly string[];
  conversationId: string;
  /** Key of a request to focus the message box. */
  focusRequest?: string;
  onFocusRequestDone(key: string): void;
  onPinRequest: () => void;
  pendingAuthorization?: ConversationPendingMessagesReport["authorization"];
  pendingGeneratedAtRef: { current: string | undefined };
  pendingMessages: readonly ConversationMailboxMessage[];
  /** Lets the page add a quote of selected text to the draft. */
  ref?: Ref<Pick<ConversationComposerHandle, "appendText">>;
  /** The last Review item that Junior added in the transcript. */
  reviewItemId?: string;
  /**
   * True when history is live and no Turn has started, so the next Turn will
   * read a new send at once.
   */
  sendsInline: boolean;
  /** True while the conversation has a Turn that a stop can end. */
  stoppable: boolean;
}) {
  const appendMessage = useAppendConversationMessage(props.conversationId);
  // A message closes the review items that it answers. Ask before it drops
  // answers that the reader did not send.
  const unsentAnswers = useConfirmUnsentAnswers();
  const stopTurn = useStopConversationTurn(props.conversationId);
  const stopTurnRef = useRef(stopTurn);
  stopTurnRef.current = stopTurn;
  const cancelPendingMessages = useCancelConversationPendingMessages(
    props.conversationId,
  );
  const [editTargetInboundMessageId, setEditTargetInboundMessageId] =
    useState<string>();
  const [queueActionError, setQueueActionError] = useState<string>();
  // While Junior waits for an answer, hide the message box and the queued
  // messages, so the reader answers in the question and does not type the
  // answer as a new message.
  // Dismiss on the question closes the item and shows the message box again.
  // The message box stays mounted, so its text and images stay, and it does
  // not hide while it has focus.
  const reviewItemQuery = useReviewItemData(props.reviewItemId);
  const reviewItem = reviewItemQuery.data;
  const [composerShownForItemId, setComposerShownForItemId] =
    useState<string>();
  const [composerFocused, setComposerFocused] = useState(false);
  const question =
    reviewItem &&
    !props.stoppable &&
    !composerFocused &&
    reviewItemWaitsForAnswer(reviewItem) &&
    composerShownForItemId !== reviewItem.id
      ? reviewItem
      : undefined;
  // The message box can show only because it has focus. Using the queued
  // messages moves focus out of it, so keep them shown for this item.
  const keepComposerShown = () => {
    if (composerFocused && reviewItem && reviewItemWaitsForAnswer(reviewItem)) {
      setComposerShownForItemId(reviewItem.id);
    }
  };
  // Keep submit identity stable across mutation status flips so the memoized
  // composer does not re-render while the reader is still typing.
  const appendMessageRef = useRef(appendMessage);
  appendMessageRef.current = appendMessage;
  const cancelPendingMessagesRef = useRef(cancelPendingMessages);
  cancelPendingMessagesRef.current = cancelPendingMessages;
  const onPinRequestRef = useRef(props.onPinRequest);
  onPinRequestRef.current = props.onPinRequest;
  const pendingMessageVersion = props.pendingMessages
    .map((message) =>
      [
        message.inboundMessageId,
        message.messageId,
        message.clientStatus,
        message.delivery,
      ].join(":"),
    )
    .join("|");
  const pendingMessageVersionRef = useRef(pendingMessageVersion);
  useEffect(() => {
    if (pendingMessageVersionRef.current === pendingMessageVersion) return;
    pendingMessageVersionRef.current = pendingMessageVersion;
    if (!window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
    onPinRequestRef.current();
  }, [pendingMessageVersion]);
  // No Turn runs and nothing waits in the queue, so the next send would
  // leave the queue almost at once. Show it in the transcript instead. A
  // conversation can be active before its Turn starts; that still counts.
  const committedIds = new Set(props.committedMessageIds);
  const sendInlineRef = useRef(false);
  sendInlineRef.current =
    props.sendsInline &&
    !props.pendingMessages.some(
      (message) => !committedIds.has(message.messageId),
    );
  const onSubmit = useCallback(
    async (message: string, idempotencyKey: string, images?: InputImage[]) => {
      await appendMessageRef.current.mutateAsync({
        idempotencyKey,
        inline: sendInlineRef.current,
        message,
        images,
      });
    },
    [],
  );
  const onRetry = useCallback((message: ConversationMailboxMessage) => {
    if (!message.idempotencyKey || (!message.text && !message.images?.length))
      return;
    void appendMessageRef.current.mutateAsync({
      idempotencyKey: message.idempotencyKey,
      message: message.text ?? "",
      images: message.images,
    });
  }, []);
  const onSubmitStart = useCallback(() => {
    // Keep an in-flight remove intact so optimistic cache rollback stays coherent.
    if (!cancelPendingMessagesRef.current.isPending) {
      cancelPendingMessagesRef.current.reset();
    }
    if (!stopTurnRef.current.isPending) stopTurnRef.current.reset();
    setQueueActionError(undefined);
    onPinRequestRef.current();
  }, []);
  const cancellableMessageIds = props.pendingMessages
    .filter((message) => message.clientStatus === undefined)
    .map((message) => message.inboundMessageId);
  const onCancelMessage = useCallback(
    (message: ConversationMailboxMessage) => {
      const receivedBefore = props.pendingGeneratedAtRef.current;
      if (!receivedBefore) return;
      cancelPendingMessagesRef.current.mutate({
        inboundMessageIds: [message.inboundMessageId],
        receivedBefore,
      });
    },
    [props.pendingGeneratedAtRef],
  );
  const cancelTargetInboundMessageId =
    cancelPendingMessages.variables?.inboundMessageIds[0];
  const cancelError = Boolean(
    cancelPendingMessages.error &&
    cancelPendingMessages.variables?.inboundMessageIds.some((id) =>
      cancellableMessageIds.includes(id),
    ),
  );

  // Edit uses its own cancel mutation so remove errors stay on remove.
  const editCancel = useCancelConversationPendingMessages(props.conversationId);
  const editCancelRef = useRef(editCancel);
  editCancelRef.current = editCancel;
  const editingRef = useRef(false);
  const composerRef = useRef<ConversationComposerHandle>(null);
  useImperativeHandle(props.ref, () => ({
    appendText: (text) => composerRef.current?.appendText(text),
  }));
  // Focus keeps the message box shown, so wait until the question is known.
  // On a touch screen, focus would open the keyboard over the transcript.
  const reviewItemPending =
    Boolean(props.reviewItemId) && reviewItemQuery.isPending;
  const { focusRequest, onFocusRequestDone } = props;
  const questionShown = Boolean(question);
  useEffect(() => {
    if (!focusRequest || reviewItemPending) return;
    onFocusRequestDone(focusRequest);
    if (!questionShown && !touchKeyboardMatches()) composerRef.current?.focus();
  }, [focusRequest, onFocusRequestDone, questionShown, reviewItemPending]);
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const onEditMessage = useCallback(
    async (message: ConversationMailboxMessage) => {
      const receivedBefore = props.pendingGeneratedAtRef.current;
      // The image read runs before the cancel starts, so isPending alone does
      // not stop a second click.
      if (!receivedBefore || editingRef.current) return;
      editingRef.current = true;
      const inboundMessageId = message.inboundMessageId;
      setEditTargetInboundMessageId(inboundMessageId);
      setQueueActionError(undefined);
      try {
        // Read images first. A failed read must leave the message queued.
        const images = await readStoredComposerImages(
          props.conversationId,
          message.attachments,
        );
        // The reader left during the read. Keep the message in the queue.
        if (!composerRef.current) return;
        // Check before the cancel. After it, images that do not fit are lost.
        if (!composerRef.current.canRestoreImages(images)) {
          setQueueActionError("Remove some draft images to edit that message.");
          return;
        }
        const result = await editCancelRef.current.mutateAsync({
          inboundMessageIds: [inboundMessageId],
          receivedBefore,
        });
        // Junior can read the message before the cancel lands, or someone
        // else can remove it. Then there is nothing to edit.
        if (!result.cancelledInboundMessageIds.includes(inboundMessageId)) {
          setQueueActionError("That message was already read or removed.");
          return;
        }
        const restored = { images, text: message.text ?? "" };
        if (composerRef.current) {
          composerRef.current.restoreMessage(restored);
        } else {
          // The reader left during the cancel. Keep the text in the saved
          // draft so it is there when they come back.
          restoreStoredDraftText(props.conversationId, restored.text);
        }
      } catch {
        setQueueActionError("Could not edit the queued message. Try again.");
      } finally {
        editingRef.current = false;
        setEditTargetInboundMessageId(undefined);
      }
    },
    [props.conversationId, props.pendingGeneratedAtRef],
  );

  const steerPendingMessages = useSteerConversationPendingMessages(
    props.conversationId,
  );
  const steerPendingMessagesRef = useRef(steerPendingMessages);
  steerPendingMessagesRef.current = steerPendingMessages;
  const onSteerMessage = useCallback((message: ConversationMailboxMessage) => {
    if (steerPendingMessagesRef.current.isPending) return;
    setQueueActionError(undefined);
    const inboundMessageId = message.inboundMessageId;
    steerPendingMessagesRef.current.mutate(
      { inboundMessageIds: [inboundMessageId] },
      {
        onError: () =>
          setQueueActionError(
            "Could not send the queued message now. Try again.",
          ),
        // No id comes back when the message is not a queued `defer` message
        // anymore. Junior read it, someone removed it, or another tab
        // steered it. The message names all three.
        onSuccess: (result) => {
          if (!result.steeredInboundMessageIds.includes(inboundMessageId)) {
            setQueueActionError(
              "That message was already read, steered, or removed.",
            );
          }
        },
      },
    );
  }, []);
  const steerTargetInboundMessageId = steerPendingMessages.isPending
    ? steerPendingMessages.variables?.inboundMessageIds[0]
    : undefined;

  const onStop = useCallback(async () => {
    const result = await stopTurnRef.current.mutateAsync();
    const restored = result.stoppedMessages.map((message) => message.text);
    return restored.length ? restored.join("\n") : undefined;
  }, []);

  const onMailboxLayoutChange = useCallback(() => {
    if (!window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
    onPinRequestRef.current();
  }, []);
  // Mobile keyboard open shrinks the transcript. Focus must re-pin the latest
  // message so the reader does not stay stuck above the docked composer.
  const onComposerFocus = useCallback(() => {
    if (!window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
    onPinRequestRef.current();
  }, []);

  return (
    <ComposerDock
      above={
        <>
          {props.pendingAuthorization ? (
            <PendingAuthorization authorization={props.pendingAuthorization} />
          ) : null}
          {/* Queued messages hide with the message box, so the question is
              the last thing above the dock. */}
          <div
            hidden={Boolean(question)}
            onFocus={keepComposerShown}
            onPointerDown={keepComposerShown}
          >
            <PendingMailboxStack
              authors={props.authors}
              cancelError={cancelError}
              cancelPending={cancelPendingMessages.isPending}
              cancelTargetInboundMessageId={cancelTargetInboundMessageId}
              committedMessageIds={props.committedMessageIds}
              conversationId={props.conversationId}
              editTargetInboundMessageId={editTargetInboundMessageId}
              messages={props.pendingMessages}
              onCancelMessage={onCancelMessage}
              onEditMessage={onEditMessage}
              onLayoutChange={onMailboxLayoutChange}
              onRetry={onRetry}
              onSteerMessage={props.stoppable ? onSteerMessage : undefined}
              steerTargetInboundMessageId={steerTargetInboundMessageId}
              viewerEmail={viewerEmail}
            />
          </div>
          {unsentAnswers.dialog}
        </>
      }
    >
      <div
        hidden={Boolean(question)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setComposerFocused(false);
          }
        }}
        onFocus={() => setComposerFocused(true)}
      >
        <ConversationComposer
          confirmSubmit={unsentAnswers.confirmSubmit}
          draftId={props.conversationId}
          error={
            queueActionError ??
            (stopTurn.error ? "Could not stop Junior. Try again." : undefined)
          }
          ref={composerRef}
          label="Continue this conversation"
          submitLabel="Send"
          onFocus={onComposerFocus}
          onStop={props.stoppable ? onStop : undefined}
          stopPending={stopTurn.isPending}
          onSubmitStart={onSubmitStart}
          onSubmit={onSubmit}
        />
      </div>
    </ComposerDock>
  );
}
