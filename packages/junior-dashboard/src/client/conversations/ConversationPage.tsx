import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useConversationData,
  type PendingArchiveConversationUpdate,
} from "./queries";
import { conversationIsResponding } from "./transcript";
import type { ConversationMailboxMessage } from "./conversationOutbox";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyMarkdownButton } from "./CopyMarkdownButton";
import { ConversationBrief } from "./ConversationBrief";
import {
  CONVERSATION_EVENT_PARAM,
  parseConversationEventSeq,
} from "./conversationRoutes";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationForkLinks } from "./ConversationForkLinks";
import { ConversationHeaderMeta } from "./ConversationHeaderMeta";
import {
  ConversationAnnotations,
  ConversationPrivacyChip,
  ConversationStats,
  hasConversationAnnotations,
  hasConversationStats,
  PendingAuthorization,
} from "./ConversationMeta";
import { PendingMailboxStack } from "./PendingMailboxStack";
import {
  buildConversations,
  conversationDisplayTitle,
  conversationFromDetail,
  visualStatusForConversation,
} from "../format";
import { Card } from "../components/layout/Card";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../components/ParticipantAvatarStack";
import { ChatLayout } from "./ChatLayout";
import { ComposerDock } from "./ComposerDock";
import { Transcript } from "./TranscriptView";
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

/** Render the selected conversation transcript inside the workspace. */
export function ConversationPage(props: {
  conversationId: string;
  data?: { conversations: ConversationFeed };
  onRead?(conversationId: string, lastReadAt: string): void;
  pendingArchiveUpdate?: PendingArchiveConversationUpdate;
}) {
  const [subagentTarget, setSubagentTarget] =
    useState<SubagentTranscriptTarget>();
  const [searchParams, setSearchParams] = useSearchParams();
  // The URL owns the open event log entry so readers can share that link.
  const selectedEventSeq = parseConversationEventSeq(
    searchParams.get(CONVERSATION_EVENT_PARAM),
  );
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
  useEffect(() => {
    if (!conversation) return;
    onRead?.(conversation.id, conversation.lastSeenAt);
  }, [conversation, onRead]);
  const transcript = detail.data;
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
        conversationId: part.childConversationId,
        part,
      });
    },
    [],
  );

  return (
    <>
      <ChatLayout
        scrollMinTall
        scrollAriaLabel="Conversation transcript"
        scrollClassName="px-4 pb-4 md:px-7 md:pb-6"
        scroll={
          <section className="min-w-0">
            <ConversationHeader
              conversationId={conversationId}
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
              lastActivityAt={conversation?.lastSeenAt}
              sentryConversationUrl={detail.data?.sentryConversationUrl}
              copyAction={
                <CopyMarkdownButton
                  key={conversationDetail?.conversationId ?? "loading"}
                  getMarkdown={
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
              annotations={
                hasConversationAnnotations(detail.data?.annotations) ? (
                  <ConversationAnnotations detail={detail.data} />
                ) : null
              }
              linkedWork={
                hasConversationAnnotations(detail.data?.annotations) ? (
                  <ConversationAnnotations
                    detail={detail.data}
                    layout="strip"
                  />
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
              brief={
                detail.data?.brief ? (
                  <ConversationBrief
                    brief={detail.data.brief}
                    variant="summary"
                  />
                ) : null
              }
              identity={identity}
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
                <ConversationPrivacyChip
                  visibility={conversation?.visibility}
                />
              }
              search={search}
              stats={
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
              title={conversationDisplayTitle(conversation)}
              view={view}
            />

            <div
              className={
                view === "raw"
                  ? "w-full pt-5 md:pt-7"
                  : "mx-auto w-full max-w-[52.5rem] pt-5 md:pt-7"
              }
            >
              {detail.isPending ? (
                <TranscriptLoading />
              ) : detail.error && !detail.data ? (
                <Card className="border-white/[0.07] bg-white/[0.025] p-4 font-sans text-xs leading-relaxed text-dashboard-text-muted">
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
                    live={live}
                    loadingPreviousPage={detail.isLoadingPreviousPage}
                    onLoadPreviousPage={detail.loadPreviousPage}
                    onSelectedEventSeqChange={setSelectedEventSeq}
                    pinRequestVersion={pinRequestVersion}
                    responding={
                      !detail.error && conversationIsResponding(transcript)
                    }
                    onOpenSubagentTranscript={onOpenSubagentTranscript}
                    search={search}
                    selectedEventSeq={selectedEventSeq}
                    transcript={transcript}
                    view={view}
                  />
                </>
              )}
            </div>
          </section>
        }
        dock={
          view === "rich" && detail.data?.isParticipant ? (
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
            />
          ) : undefined
        }
      />
      <SubagentTranscriptDrawer
        onClose={() => setSubagentTarget(undefined)}
        target={subagentTarget}
      />
    </>
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
}) {
  const appendMessage = useAppendConversationMessage(props.conversationId);
  const cancelPendingMessages = useCancelConversationPendingMessages(
    props.conversationId,
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
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    onPinRequestRef.current();
  }, [pendingMessageVersion]);
  const onSubmit = useCallback(
    async (message: string, idempotencyKey: string, images?: InputImage[]) => {
      await appendMessageRef.current.mutateAsync({
        idempotencyKey,
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
          <PendingMailboxStack
            cancelError={cancelError}
            cancelPending={cancelPendingMessages.isPending}
            cancelTargetInboundMessageId={cancelTargetInboundMessageId}
            committedMessageIds={props.committedMessageIds}
            messages={props.pendingMessages}
            onCancelMessage={onCancelMessage}
            onLayoutChange={onMailboxLayoutChange}
            onRetry={onRetry}
          />
        </>
      }
    >
      <ConversationComposer
        draftId={props.conversationId}
        label="Continue this conversation"
        submitLabel="Send"
        onFocus={onComposerFocus}
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
