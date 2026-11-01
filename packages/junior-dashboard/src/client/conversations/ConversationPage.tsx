import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSearchParams } from "react-router";
import type {
  ConversationDetailReport,
  ConversationFeed,
  ConversationPendingMessagesReport,
  InputImage,
} from "@sentry/junior/api/schema";

import {
  useAppendConversationMessage,
  useArchiveConversation,
  useCancelConversationPendingMessages,
  useSteerConversationPendingMessages,
  useConversationData,
  useStopConversationTurn,
  type PendingArchiveConversationUpdate,
} from "./queries";
import { conversationIsResponding } from "./transcript";
import type { ConversationMailboxMessage } from "./conversationOutbox";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyButton } from "../components/CopyButton";
import { ConversationBrief } from "./ConversationBrief";
import {
  CONVERSATION_EVENT_PARAM,
  parseConversationEventSeq,
} from "./conversationRoutes";
import {
  ConversationComposer,
  restoreStoredDraftText,
  type ConversationComposerHandle,
} from "./ConversationComposer";
import { readStoredComposerImages } from "./ComposerImages";
import { useDashboardCoreData } from "../api";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationDetails } from "./ConversationDetails";
import { ConversationEventDetails } from "./ConversationEventDetails";
import { ConversationEventLogLoading } from "./ConversationEventLog";
import {
  adjacentEventLogSeqs,
  eventLogRows,
  filterEventLogRows,
} from "./eventLog";
import { TranscriptSearchProvider } from "./transcriptSearch";
import {
  TurnContextDetails,
  type TurnContextPanel,
  type TurnContextSelection,
} from "./TranscriptTurnContextView";
import { cn } from "../styles";
import { ConversationForkLinks } from "./ConversationForkLinks";
import { ConversationAgentTree } from "./ConversationAgentTree";
import { ConversationHeaderMeta } from "./ConversationHeaderMeta";
import { conversationLinks } from "./ConversationLinkedWork";
import {
  ConversationAnnotations,
  ConversationPrivacyChip,
  ConversationStats,
  hasConversationAnnotations,
  hasConversationStats,
  PendingAuthorization,
} from "./ConversationMeta";
import {
  ConversationUsageBreakdown,
  hasConversationUsageBreakdown,
} from "./ConversationUsageBreakdown";
import { PendingMailboxStack } from "./PendingMailboxStack";
import {
  buildConversations,
  conversationDetailTitle,
  conversationDisplayTitle,
  conversationFromDetail,
  visualStatusForConversation,
} from "../format";
import { useDocumentTitle } from "../documentTitle";
import { Card } from "../components/layout/Card";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../components/ParticipantAvatarStack";
import { ChatLayout } from "./ChatLayout";
import { ComposerDock } from "./ComposerDock";
import { ConversationReviewBar } from "../review-desk/ConversationReviewBar";
import { Transcript } from "./TranscriptView";
import {
  readConversationStartPosition,
  useMarkConversationRead,
  useReadPositionAtOpen,
} from "./transcriptReadPosition";
import { TranscriptLoading } from "./TranscriptLoading";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "./SubagentTranscriptDrawer";
import type {
  Conversation,
  ConversationTranscript,
  TranscriptViewSubagentPart,
} from "../types";

export { liveModelId } from "./ConversationMeta";

const detailsDefaultOpenQuery = "(min-width: 1440px)";

function subscribeToDetailsLayout(onChange: () => void) {
  const media = window.matchMedia(detailsDefaultOpenQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Render the selected conversation transcript inside the workspace. */
export function ConversationPage(props: {
  conversationId: string;
  data?: { conversations: ConversationFeed };
  onRead?(conversationId: string, lastReadAt: string): void;
  pendingArchiveUpdate?: PendingArchiveConversationUpdate;
}) {
  const detailsDefaultOpen = useSyncExternalStore(
    subscribeToDetailsLayout,
    () => window.matchMedia(detailsDefaultOpenQuery).matches,
    () => false,
  );
  const pageRef = useRef<HTMLDivElement>(null);
  const [subagentTarget, setSubagentTarget] =
    useState<SubagentTranscriptTarget>();
  const [searchParams, setSearchParams] = useSearchParams();
  // The URL owns the open event log entry so readers can share that link.
  const selectedEventSeq = parseConversationEventSeq(
    searchParams.get(CONVERSATION_EVENT_PARAM),
  );
  // Event details and turn context show over Conversation details. Closing
  // them shows details again when details are open. A linked event starts
  // with details closed, so closing it does not open a panel nobody chose.
  const [detailsChoice, setDetailsChoice] = useState<boolean | undefined>(() =>
    selectedEventSeq === undefined ? undefined : false,
  );
  const detailsOpen = detailsChoice ?? detailsDefaultOpen;
  const [turnContext, setTurnContext] = useState<TurnContextSelection>();
  const eventOpen = selectedEventSeq !== undefined;
  const showDetails = detailsOpen && !eventOpen && !turnContext;
  const [viewState, setView] = useState<TranscriptViewMode>(() =>
    selectedEventSeq === undefined ? "rich" : "raw",
  );
  const view = selectedEventSeq === undefined ? viewState : "raw";
  const [search, setSearch] = useState("");
  const [pinRequestVersion, setPinRequestVersion] = useState(0);
  const conversationId = props.conversationId;
  const onRead = props.onRead;
  const summaries = props.data?.conversations.conversations ?? [];
  const conversations = buildConversations(summaries);
  const detail = useConversationData(conversationId);
  const archive = useArchiveConversation(conversationId);
  const markRead = useMarkConversationRead(conversationId);
  const readAtOpen = useReadPositionAtOpen(detail.data);
  const feedConversation = conversations.find(
    (item) => item.id === conversationId,
  );
  const conversation = applyPendingArchiveUpdate(
    conversationFromDetail(detail.data) ?? feedConversation,
    props.pendingArchiveUpdate,
  );
  const participants = conversationParticipants(conversation);
  const identity =
    participants.length > 0 ? (
      <ParticipantAvatarStack participants={participants} size="detail" />
    ) : null;
  const conversationDetail = detail.data;
  const title =
    conversationDetailTitle(detail.data) ??
    conversationDisplayTitle(conversation);
  useDocumentTitle(detail.data || conversation ? title : undefined);
  const agentTree = detail.data?.agentTree;
  useEffect(() => {
    if (!conversation) return;
    onRead?.(conversation.id, conversation.lastSeenAt);
  }, [conversation, onRead]);
  const transcript = detail.data;
  const selectedEvent =
    transcript?.eventHistory.status === "expired"
      ? undefined
      : transcript?.events.find((event) => event.seq === selectedEventSeq);
  const visualStatus = conversation
    ? visualStatusForConversation(conversation)
    : undefined;
  // History and mailbox use the same deferred server snapshot.
  const live = conversationIsLive(visualStatus, detail.data);
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
  const setSelectedEventSeq = useCallback(
    (seq: number | undefined) => {
      // Keep the event log after close, even when a link opened the page.
      setView("raw");
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (seq === undefined) next.delete(CONVERSATION_EVENT_PARAM);
          else next.set(CONVERSATION_EVENT_PARAM, String(seq));
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const onViewChange = useCallback(
    (value: TranscriptViewMode) => {
      if (value !== "raw" && selectedEventSeq !== undefined) {
        setSelectedEventSeq(undefined);
      }
      // Turn context belongs to a message in the Conversation view.
      setTurnContext(undefined);
      setView(value);
    },
    [selectedEventSeq, setSelectedEventSeq],
  );
  // A linked event can be older than the first page. Load earlier pages until
  // it is present or history ends.
  const loadPreviousPageRef = useRef(detail.loadPreviousPage);
  loadPreviousPageRef.current = detail.loadPreviousPage;
  const oldestLoadedSeq = transcript?.events[0]?.seq;
  const linkedEventMissing =
    selectedEventSeq !== undefined &&
    oldestLoadedSeq !== undefined &&
    selectedEventSeq < oldestLoadedSeq;
  const loadLinkedEvent =
    linkedEventMissing &&
    detail.hasPreviousPage &&
    !detail.isLoadingPreviousPage &&
    !detail.historyError;
  useEffect(() => {
    if (loadLinkedEvent) loadPreviousPageRef.current();
  }, [loadLinkedEvent, oldestLoadedSeq]);
  // Keep the panel while the transcript or a linked event loads.
  const eventLoading =
    eventOpen &&
    !selectedEvent &&
    (detail.isPending ||
      (linkedEventMissing &&
        (detail.hasPreviousPage || detail.isLoadingPreviousPage) &&
        !detail.historyError));
  const showEvent = Boolean(selectedEvent) || eventLoading;
  // Step through the same filtered rows that the event log shows.
  const events = transcript?.events;
  const normalizedSearch = search.trim().toLowerCase();
  const eventRows = useMemo(
    () =>
      eventOpen && events
        ? filterEventLogRows(eventLogRows(events), normalizedSearch)
        : [],
    [eventOpen, events, normalizedSearch],
  );
  const turnContextPanel = useMemo<TurnContextPanel>(
    () => ({
      openId: turnContext?.id,
      onToggle: (selection) =>
        setTurnContext((current) =>
          current?.id === selection.id ? undefined : selection,
        ),
    }),
    [turnContext?.id],
  );
  const requestPin = useCallback(() => {
    setPinRequestVersion((version) => version + 1);
  }, []);
  const onOpenSubagentTranscript = useCallback(
    ({
      part,
    }: {
      part: TranscriptViewSubagentPart;
      conversation: ConversationTranscript;
    }) => {
      setSubagentTarget({
        ...(part.agentName ? { agentName: part.agentName } : undefined),
        conversationId: part.childConversationId,
        label: part.title ?? part.agentName,
        status: part.status,
      });
    },
    [],
  );

  const closeEventDetails = () => {
    const trigger = pageRef.current?.querySelector<HTMLButtonElement>(
      `[data-event-seq="${selectedEventSeq}"] button`,
    );
    setSelectedEventSeq(undefined);
    trigger?.focus({ preventScroll: true });
  };
  const closeTurnContext = () => {
    // A message can have one context control per layout. Focus the visible one.
    const trigger = [
      ...(pageRef.current?.querySelectorAll<HTMLButtonElement>(
        `[data-turn-context-id="${CSS.escape(turnContext?.id ?? "")}"]`,
      ) ?? []),
    ].find((button) => button.getClientRects().length > 0);
    setTurnContext(undefined);
    trigger?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={pageRef}
      className={cn(
        "grid h-full min-h-0 min-w-0",
        (showDetails || showEvent || turnContext) &&
          "xl:grid-cols-[minmax(0,1fr)_25rem]",
      )}
    >
      <ChatLayout
        header={
          <ConversationHeader
            agentTree={
              agentTree ? <ConversationAgentTree nodes={agentTree} /> : null
            }
            conversationId={conversationId}
            detailsOpen={showDetails}
            onDetailsClick={() => {
              if (eventOpen) setSelectedEventSeq(undefined);
              setTurnContext(undefined);
              setDetailsChoice(!showDetails);
            }}
            forks={
              detail.data?.forkedFromConversationId ||
              detail.data?.forks?.length ? (
                <ConversationForkLinks
                  forkedFromConversationId={
                    detail.data.forkedFromConversationId
                  }
                  forkedFromTitle={detail.data.forkedFromTitle}
                  forks={detail.data.forks}
                />
              ) : null
            }
            copyAction={
              <CopyButton
                label="Copy as Markdown"
                copyingLabel="Preparing Markdown"
                key={conversationDetail?.conversationId ?? "loading"}
                getText={
                  conversationDetail
                    ? async () =>
                        buildConversationMarkdown(
                          await detail.loadCompleteTranscript(),
                          conversation,
                        )
                    : undefined
                }
              />
            }
            linkedWork={
              hasConversationAnnotations(detail.data?.annotations) ? (
                <ConversationAnnotations detail={detail.data} />
              ) : null
            }
            archive={{
              archived: Boolean(conversation?.archivedAt),
              disabled: !conversation || archive.isPending,
              error: Boolean(archive.error),
              onClick: () =>
                archive.mutate({
                  archived: !conversation?.archivedAt,
                  lastSeenAt: conversation!.lastSeenAt,
                }),
              pending: archive.isPending,
            }}
            live={live}
            meta={
              <ConversationHeaderMeta
                identity={identity}
                stats={
                  hasConversationStats({
                    conversation,
                    detail: detail.data,
                    variant: "compact",
                  }) ? (
                    <ConversationStats
                      conversation={conversation}
                      detail={detail.data}
                      variant="compact"
                    />
                  ) : null
                }
              />
            }
            onSearchChange={setSearch}
            onViewChange={onViewChange}
            privacy={
              <ConversationPrivacyChip visibility={conversation?.visibility} />
            }
            search={search}
            title={title}
            view={view}
          />
        }
        scrollMinTall
        scrollAriaLabel="Conversation transcript"
        scrollClassName={
          view === "raw" ? undefined : "px-4 pb-4 md:px-7 md:pb-6"
        }
        scroll={
          <section className="min-w-0">
            <div
              className={
                view === "raw"
                  ? "w-full"
                  : "mx-auto w-full max-w-[52.5rem] pt-5 md:pt-7"
              }
            >
              {detail.isPending ? (
                view === "raw" ? (
                  <ConversationEventLogLoading />
                ) : (
                  <TranscriptLoading />
                )
              ) : detail.error && !detail.data ? (
                <Card className="border-dashboard-border bg-dashboard-fill-soft p-4 font-sans text-xs leading-relaxed text-dashboard-text-muted">
                  {detail.error.message}
                </Card>
              ) : (
                <>
                  {detail.error ? (
                    <div className="mb-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.045] px-3 py-2 font-sans text-xs text-amber-100/65">
                      Transcript refresh failed. Showing the latest available
                      data.
                    </div>
                  ) : null}
                  <Transcript
                    hasPreviousPage={detail.hasPreviousPage}
                    historyError={detail.historyError}
                    historyVersion={detail.historyVersion}
                    lastReadSeq={readAtOpen.lastReadSeq}
                    live={live}
                    loadingPreviousPage={detail.isLoadingPreviousPage}
                    onLoadPreviousPage={detail.loadPreviousPage}
                    onRead={markRead}
                    onSelectedEventSeqChange={setSelectedEventSeq}
                    pendingMessages={detail.inlineMessages}
                    pinRequestVersion={pinRequestVersion}
                    responding={
                      !detail.error && conversationIsResponding(transcript)
                    }
                    onOpenSubagentTranscript={onOpenSubagentTranscript}
                    search={search}
                    onSearchChange={setSearch}
                    selectedEventSeq={selectedEventSeq}
                    startAtUnread={readConversationStartPosition() === "unread"}
                    transcript={transcript}
                    turnContextPanel={turnContextPanel}
                    unread={readAtOpen.unread}
                    view={view}
                  />
                </>
              )}
            </div>
          </section>
        }
        dock={
          // A child Conversation takes input only from its parent agent, and it
          // runs without interactive auth, so it has no approval to show.
          view === "rich" && detail.data?.isParticipant && !agentTree ? (
            <ConversationReplyFooter
              conversationId={conversationId}
              // Only pass committed ids for mailbox de-dupe. The full transcript is
              // too large to re-enter the footer on every live poll while typing.
              committedMessageIds={mailboxCommittedIds}
              onPinRequest={requestPin}
              pendingAuthorization={detail.pendingAuthorization}
              // Keep the cancel watermark off props. Live polls refresh generatedAt
              // every 2s; a prop would bust footer memo while the reader types.
              pendingGeneratedAtRef={pendingGeneratedAtRef}
              pendingMessages={detail.pendingMessages}
              // Without live history, an inline send would never leave the
              // transcript tail. A started Turn reads a new send only later.
              // Keep those sends in the queue. An earlier inline send that
              // history does not have yet can start that Turn first.
              sendsInline={
                detail.data.eventHistory.status === "available" &&
                !conversationIsResponding(detail.data) &&
                detail.inlineMessages.length === 0
              }
              stoppable={live}
            />
          ) : undefined
        }
      />
      {showDetails ? (
        <ConversationDetails
          conversationId={conversationId}
          identity={identity}
          sentryConversationUrl={detail.data?.sentryConversationUrl}
          onClose={() => setDetailsChoice(false)}
          onOpenSubagent={setSubagentTarget}
          links={conversationLinks(detail.data)}
          brief={
            detail.data?.brief ? (
              <ConversationBrief brief={detail.data.brief} variant="summary" />
            ) : null
          }
          overview={
            hasConversationStats({
              conversation,
              detail: detail.data,
            }) ? (
              <ConversationStats
                conversation={conversation}
                detail={detail.data}
              />
            ) : null
          }
          usage={
            hasConversationUsageBreakdown({
              conversation,
              detail: detail.data,
            }) ? (
              <ConversationUsageBreakdown
                conversation={conversation}
                detail={detail.data}
              />
            ) : null
          }
        />
      ) : null}
      {showEvent ? (
        <ConversationEventDetails
          conversation={transcript}
          event={selectedEvent}
          onClose={closeEventDetails}
          onSelect={setSelectedEventSeq}
          {...adjacentEventLogSeqs(eventRows, selectedEventSeq)}
        />
      ) : null}
      {turnContext ? (
        <TranscriptSearchProvider query={search}>
          <TurnContextDetails
            actor={turnContext.actor}
            contexts={turnContext.contexts}
            key={turnContext.id}
            onClose={closeTurnContext}
            timestamp={turnContext.timestamp}
          />
        </TranscriptSearchProvider>
      ) : null}
      <SubagentTranscriptDrawer
        onClose={() => setSubagentTarget(undefined)}
        target={subagentTarget}
      />
    </div>
  );
}

/**
 * Own mutation state and mailbox chrome outside the page tree that re-renders
 * on every live transcript poll. Keeps composer props stable while typing.
 *
 * Memoized so metadata-only polls that keep mailbox identity stable skip the
 * footer tree. Fast chat UIs isolate the composer the same way.
 */
const ConversationReplyFooter = memo(function ConversationReplyFooter(props: {
  committedMessageIds: readonly string[];
  conversationId: string;
  onPinRequest: () => void;
  pendingAuthorization?: ConversationPendingMessagesReport["authorization"];
  pendingGeneratedAtRef: { current: string | undefined };
  pendingMessages: readonly ConversationMailboxMessage[];
  /**
   * True when history is live and no Turn has started, so the next Turn will
   * read a new send at once.
   */
  sendsInline: boolean;
  /** True while the conversation has a Turn that a stop can end. */
  stoppable: boolean;
}) {
  const appendMessage = useAppendConversationMessage(props.conversationId);
  const stopTurn = useStopConversationTurn(props.conversationId);
  const stopTurnRef = useRef(stopTurn);
  stopTurnRef.current = stopTurn;
  const cancelPendingMessages = useCancelConversationPendingMessages(
    props.conversationId,
  );
  const [editTargetInboundMessageId, setEditTargetInboundMessageId] =
    useState<string>();
  const [queueActionError, setQueueActionError] = useState<string>();
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
    if (!window.matchMedia("(max-width: 767px)").matches) return;
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
        // Junior can read the message before the cancel lands. Then it is
        // already in the Conversation and there is nothing to edit.
        if (!result.cancelledInboundMessageIds.includes(inboundMessageId)) {
          setQueueActionError("Junior already read that message.");
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
    steerPendingMessagesRef.current.mutate(
      { inboundMessageIds: [message.inboundMessageId] },
      {
        onError: () =>
          setQueueActionError(
            "Could not send the queued message now. Try again.",
          ),
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
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    onPinRequestRef.current();
  }, []);
  // Mobile keyboard open shrinks the transcript. Focus must re-pin the latest
  // message so the reader does not stay stuck above the docked composer.
  const onComposerFocus = useCallback(() => {
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    onPinRequestRef.current();
  }, []);

  return (
    <ComposerDock
      above={
        <>
          {props.pendingAuthorization ? (
            <PendingAuthorization authorization={props.pendingAuthorization} />
          ) : null}
          <ConversationReviewBar conversationId={props.conversationId} />
          <PendingMailboxStack
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
        </>
      }
    >
      <ConversationComposer
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
    </ComposerDock>
  );
});

function applyPendingArchiveUpdate(
  conversation: Conversation | undefined,
  update: PendingArchiveConversationUpdate | undefined,
): Conversation | undefined {
  const updatedConversation =
    conversation ??
    (update?.conversation
      ? buildConversations([update.conversation])[0]
      : undefined);
  if (!updatedConversation || !update) return updatedConversation;
  return {
    ...updatedConversation,
    archivedAt: update.archived
      ? (updatedConversation.archivedAt ?? updatedConversation.lastSeenAt)
      : null,
  };
}

function conversationIsLive(
  visualStatus: ReturnType<typeof visualStatusForConversation> | undefined,
  detail: ConversationDetailReport | undefined,
): boolean {
  if (detail) return detail.status === "active";
  return visualStatus === "active";
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
