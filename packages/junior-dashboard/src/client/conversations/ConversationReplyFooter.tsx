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
} from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import { useConfirmUnsentAnswers } from "../inbox/UnsentAnswers";
import { readStoredComposerFiles } from "./ComposerFiles";
import { ComposerDock } from "./ComposerDock";
import {
  ConversationComposer,
  restoreStoredDraftText,
  takeStoredDraftText,
  touchKeyboardMatches,
  type ConversationComposerHandle,
} from "./ConversationComposer";
import type { ComposerConversation } from "./ComposerMention";
import type { ConversationMailboxMessage } from "./conversationOutbox";
import { PendingAuthorization } from "./ConversationMeta";
import { PendingMailboxStack } from "./PendingMailboxStack";
import { queuedTextInDraft, setQueuedTextInDraft } from "./queuedEditText";
import {
  useAppendConversationMessage,
  useCancelConversationPendingMessages,
  useSteerConversationPendingMessages,
  useStopConversationTurn,
} from "./queries";
import { MOBILE_LAYOUT_QUERY } from "../layoutMedia";
import { getDashboardAgentName } from "../agentName";

/** Ask the reply box for focus once per navigation `key`. */
export type ReplyFocusRequest = {
  /** The reader asked to type, so focus opens the keyboard on touch too. */
  compose?: boolean | undefined;
  /** Draft id of the composer the reader typed in before. Its text moves here. */
  draftFrom?: string;
  key: string;
};

/**
 * Own mutation state and mailbox chrome outside the page tree that re-renders
 * on every live transcript poll. Keeps composer props stable while typing.
 *
 * Memoized so metadata-only polls that keep mailbox identity stable skip the
 * footer tree. Fast chat UIs isolate the composer the same way.
 */
export const ConversationReplyFooter = memo(ReplyFooter);

function ReplyFooter(props: {
  authors?: ConversationDetailReport["authors"] | undefined;
  committedMessageIds: readonly string[];
  conversationId: string;
  /** A request to focus the message box. */
  focusRequest?: ReplyFocusRequest | undefined;
  /** The Conversation that the composer writes to. */
  conversation?: ComposerConversation | undefined;
  onFocusRequestDone(key: string): void;
  onPinRequest: () => void;
  pendingAuthorization?:
    | ConversationPendingMessagesReport["authorization"]
    | undefined;
  pendingGeneratedAtRef: { current: string | undefined };
  pendingMessages: readonly ConversationMailboxMessage[];
  /** The message box's hint when it is empty. */
  placeholder?: string | undefined;
  /** Lets the page add text, such as a quote, to the draft, or focus it. */
  ref?: Ref<Pick<ConversationComposerHandle, "appendText" | "focus">>;
  /**
   * True when history is live and no Turn has started, so the next Turn will
   * read a new send at once.
   */
  sendsInline: boolean;
  /** True while the conversation has a Turn that a stop can end. */
  stoppable: boolean;
}) {
  const appendMessage = useAppendConversationMessage(props.conversationId);
  // A message closes the Inbox items that it answers. Ask before it drops
  // answers on a question card that the reader did not send.
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
  const { confirmSubmit } = unsentAnswers;
  // Resolves to true when the queued message of the edit in flight left the
  // queue. Its text is in the draft before the cancel lands.
  const editCancelledRef = useRef<Promise<boolean>>(undefined);
  const beforeSubmit = useCallback(() => {
    const editCancelled = editCancelledRef.current;
    // A send during an edit waits for its cancel, and stops when the queued
    // message is still queued or Junior read it. Then the text does not go
    // out twice, and the reader sees the edit error. The unsent answers
    // dialog opens only after the wait, so a stopped send leaves none open.
    if (!editCancelled) return confirmSubmit();
    return (async () => {
      if (!(await editCancelled)) return false;
      return (await confirmSubmit()) ?? true;
    })();
  }, [confirmSubmit]);
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
    async (message: string, idempotencyKey: string, files?: File[]) => {
      await appendMessageRef.current.mutateAsync({
        idempotencyKey,
        inline: sendInlineRef.current,
        message,
        files,
      });
    },
    [],
  );
  const onRetry = useCallback((message: ConversationMailboxMessage) => {
    if (!message.idempotencyKey || (!message.text && !message.files?.length))
      return;
    void appendMessageRef.current.mutateAsync({
      idempotencyKey: message.idempotencyKey,
      message: message.text ?? "",
      files: message.files,
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
    focus: () => composerRef.current?.focus(),
  }));
  // On a touch screen, focus would open the keyboard over the transcript.
  const { onFocusRequestDone } = props;
  const focusKey = props.focusRequest?.key;
  const draftFrom = props.focusRequest?.draftFrom;
  const compose = props.focusRequest?.compose === true;
  useEffect(() => {
    if (!focusKey) return;
    onFocusRequestDone(focusKey);
    // A new Conversation opens here after its first send. The reader was
    // typing in its pending reply box, so the text and the cursor move here,
    // even on a touch screen where the keyboard is already open.
    const text = draftFrom ? takeStoredDraftText(draftFrom) : "";
    if (text) composerRef.current?.restoreMessage({ text });
    else if (draftFrom || compose || !touchKeyboardMatches()) {
      composerRef.current?.focus();
    }
  }, [compose, draftFrom, focusKey, onFocusRequestDone]);
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const onEditMessage = useCallback(
    async (message: ConversationMailboxMessage) => {
      const receivedBefore = props.pendingGeneratedAtRef.current;
      // The file read runs before the cancel starts, so isPending alone does
      // not stop a second click.
      if (!receivedBefore || editingRef.current) return;
      editingRef.current = true;
      const conversationId = props.conversationId;
      const inboundMessageId = message.inboundMessageId;
      const text = message.text ?? "";
      setEditTargetInboundMessageId(inboundMessageId);
      setQueueActionError(undefined);
      // Text alone moves at once, before the cancel, and into the saved
      // draft. When the edit fails, it stays with the error and the reader
      // decides. Text with files moves with its files after the cancel, so
      // the reader cannot send the text without them.
      const textFirst = !message.attachments?.length;
      let settleEdit = (_cancelled: boolean) => {};
      if (textFirst) {
        editCancelledRef.current = new Promise((resolve) => {
          settleEdit = resolve;
        });
      }
      if (textFirst && !queuedTextInDraft(conversationId, inboundMessageId)) {
        setQueuedTextInDraft(conversationId, inboundMessageId, true);
        composerRef.current?.restoreMessage({ text });
      }
      try {
        // Read files first. A failed read must leave the message queued.
        const files = await readStoredComposerFiles(
          conversationId,
          message.attachments,
        );
        // The reader left during the read. Keep the message in the queue.
        if (!composerRef.current) return;
        // Check before the cancel. After it, files that do not fit are lost.
        if (!composerRef.current.canRestoreFiles(files)) {
          setQueueActionError("Remove some draft files to edit that message.");
          return;
        }
        const result = await editCancelRef.current.mutateAsync({
          inboundMessageIds: [inboundMessageId],
          receivedBefore,
        });
        const cancelled =
          result.cancelledInboundMessageIds.includes(inboundMessageId);
        settleEdit(cancelled);
        if (textFirst) {
          setQueuedTextInDraft(conversationId, inboundMessageId, false);
        }
        // Junior can read the message before the cancel lands, or someone
        // else can remove it. Then there is nothing to edit.
        if (!cancelled) {
          setQueueActionError("That message was already read or removed.");
          return;
        }
        if (textFirst) return;
        if (composerRef.current) {
          composerRef.current.restoreMessage({ files, text });
        } else {
          // The reader left during the cancel. Keep the text in the saved
          // draft so it is there when they come back.
          restoreStoredDraftText(conversationId, text);
        }
      } catch {
        setQueueActionError("Could not edit the queued message. Try again.");
      } finally {
        settleEdit(false);
        editCancelledRef.current = undefined;
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
          {unsentAnswers.dialog}
        </>
      }
    >
      <ConversationComposer
        beforeSubmit={beforeSubmit}
        draftId={props.conversationId}
        error={
          queueActionError ??
          (stopTurn.error
            ? `Could not stop ${getDashboardAgentName()}. Try again.`
            : undefined)
        }
        conversation={props.conversation}
        linksWork
        ref={composerRef}
        label="Continue this conversation"
        placeholder={props.placeholder}
        submitLabel="Send"
        onFocus={onComposerFocus}
        onStop={props.stoppable ? onStop : undefined}
        stopPending={stopTurn.isPending}
        onSubmitStart={onSubmitStart}
        onSubmit={onSubmit}
      />
    </ComposerDock>
  );
}
