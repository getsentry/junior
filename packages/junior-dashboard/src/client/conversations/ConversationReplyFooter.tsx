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
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import {
  ComposerQuestion,
  ComposerQuestionsLoadError,
  useComposerQuestions,
  type ComposerQuestionAnswers,
} from "../review-desk/ComposerQuestion";
import { useConfirmUnsentAnswers } from "../review-desk/UnsentAnswers";
import { readStoredComposerFiles } from "./ComposerFiles";
import { ComposerDock } from "./ComposerDock";
import {
  ConversationComposer,
  restoreStoredDraftText,
  takeStoredDraftText,
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

/** Ask the reply box for focus once per navigation `key`. */
export type ReplyFocusRequest = {
  /** Draft id of the composer the reader typed in before. Its text moves here. */
  draftFrom?: string;
  key: string;
  /** The docked question to show and focus. */
  questionId?: string;
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
  authors?: ConversationDetailReport["authors"];
  committedMessageIds: readonly string[];
  conversationId: string;
  /** A request to focus the message box. */
  focusRequest?: ReplyFocusRequest;
  onFocusRequestDone(key: string): void;
  onPinRequest: () => void;
  /**
   * Show the transcript row of a docked question. `arrived` means it docked
   * by itself, not by a step or an answer of the reader.
   */
  onShowQuestion?(item: ReviewItemPayload, arrived: boolean): void;
  pendingAuthorization?: ConversationPendingMessagesReport["authorization"];
  pendingGeneratedAtRef: { current: string | undefined };
  pendingMessages: readonly ConversationMailboxMessage[];
  /** Lets the page add a quote of selected text to the draft. */
  ref?: Ref<Pick<ConversationComposerHandle, "appendText">>;
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
  // answers in the details panel that the reader did not send.
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
  // Open questions dock above the message box, and Send sends their picks
  // before the typed message. The server then closes the open questions
  // that the message answers.
  const {
    loadFailed: questionsLoadFailed,
    pending: questionsPending,
    questions,
    retry: retryQuestions,
  } = useComposerQuestions(props.conversationId);
  // The questions that docked when the Conversation opened do not move the
  // transcript. It opens at the latest message or the "New" marker.
  const openedWithRef = useRef<{ conversationId: string; ids: Set<string> }>(
    undefined,
  );
  if (
    !questionsPending &&
    openedWithRef.current?.conversationId !== props.conversationId
  ) {
    openedWithRef.current = {
      conversationId: props.conversationId,
      ids: new Set(questions.map((question) => question.id)),
    };
  }
  const { conversationId, onShowQuestion } = props;
  const showQuestion = useCallback(
    (item: ReviewItemPayload, byReader: boolean) => {
      if (byReader) {
        onShowQuestion?.(item, false);
        return;
      }
      // A question can dock from an early page before every page is in.
      // It was open when the Conversation opened, so it did not arrive.
      const openedWith = openedWithRef.current;
      if (openedWith?.conversationId !== conversationId) return;
      if (!openedWith.ids.has(item.id)) onShowQuestion?.(item, true);
    },
    [conversationId, onShowQuestion],
  );
  const questionRef = useRef<HTMLElement>(null);
  const questionAnswersRef = useRef<ComposerQuestionAnswers>(null);
  const [hasQuestionAnswers, setHasQuestionAnswers] = useState(false);
  const hasQuestionAnswersRef = useRef(hasQuestionAnswers);
  hasQuestionAnswersRef.current = hasQuestionAnswers;
  const { confirmSubmit } = unsentAnswers;
  // A failed answer keeps the draft, so the reader can send both again.
  // Only a message drops the details-panel picks, so only a message asks.
  const beforeSubmit = useCallback(
    ({ sendsMessage }: { sendsMessage: boolean }) => {
      const confirmation = sendsMessage ? confirmSubmit() : undefined;
      if (!confirmation && !hasQuestionAnswersRef.current) return undefined;
      return (async () => {
        if (confirmation && !(await confirmation)) return false;
        return (await questionAnswersRef.current?.send()) ?? true;
      })();
    },
    [confirmSubmit],
  );
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
  }));
  // Wait until the questions are known: an open question takes focus, so
  // its number keys work at once. On a touch screen, focus would open the
  // keyboard over the transcript.
  const { onFocusRequestDone } = props;
  const focusKey = props.focusRequest?.key;
  const draftFrom = props.focusRequest?.draftFrom;
  const focusQuestionId = props.focusRequest?.questionId;
  const questionShown = questions.length > 0;
  // A request for one question waits until a later page brings it in.
  const questionReady = focusQuestionId
    ? questions.some((question) => question.id === focusQuestionId)
    : questionShown;
  useEffect(() => {
    // A docked question takes the focus at once, before the reader types.
    if (!focusKey || (questionsPending && !questionReady)) return;
    onFocusRequestDone(focusKey);
    // A new Conversation opens here after its first send. The reader was
    // typing in its pending reply box, so the text and the cursor move here,
    // even on a touch screen where the keyboard is already open.
    const text = draftFrom ? takeStoredDraftText(draftFrom) : "";
    if (text) composerRef.current?.restoreMessage({ text });
    else if (draftFrom) composerRef.current?.focus();
    else if (!touchKeyboardMatches()) {
      if (focusQuestionId) questionAnswersRef.current?.show(focusQuestionId);
      if (questionShown) questionRef.current?.focus();
      else composerRef.current?.focus();
    }
  }, [
    draftFrom,
    focusKey,
    focusQuestionId,
    onFocusRequestDone,
    questionReady,
    questionShown,
    questionsPending,
  ]);
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const onEditMessage = useCallback(
    async (message: ConversationMailboxMessage) => {
      const receivedBefore = props.pendingGeneratedAtRef.current;
      // The file read runs before the cancel starts, so isPending alone does
      // not stop a second click.
      if (!receivedBefore || editingRef.current) return;
      editingRef.current = true;
      const inboundMessageId = message.inboundMessageId;
      setEditTargetInboundMessageId(inboundMessageId);
      setQueueActionError(undefined);
      try {
        // Read files first. A failed read must leave the message queued.
        const files = await readStoredComposerFiles(
          props.conversationId,
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
        // Junior can read the message before the cancel lands, or someone
        // else can remove it. Then there is nothing to edit.
        if (!result.cancelledInboundMessageIds.includes(inboundMessageId)) {
          setQueueActionError("That message was already read or removed.");
          return;
        }
        const restored = { files, text: message.text ?? "" };
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
  const focusMessageBox = useCallback(() => composerRef.current?.focus(), []);
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
          {/* The question sits right above the message box that also
              answers it. */}
          <ComposerQuestion
            answersRef={questionAnswersRef}
            focusMessageBox={focusMessageBox}
            onAnswersChange={setHasQuestionAnswers}
            onShow={showQuestion}
            questions={questions}
            ref={questionRef}
          />
          {questionsLoadFailed ? (
            <ComposerQuestionsLoadError onRetry={retryQuestions} />
          ) : null}
          {unsentAnswers.dialog}
        </>
      }
    >
      <ConversationComposer
        beforeSubmit={beforeSubmit}
        draftId={props.conversationId}
        error={
          queueActionError ??
          (stopTurn.error ? "Could not stop Junior. Try again." : undefined)
        }
        ref={composerRef}
        label="Continue this conversation"
        placeholder={questionShown ? "Or type your answer…" : undefined}
        sendsWithoutDraft={hasQuestionAnswers}
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
