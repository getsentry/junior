import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ConversationDetailReport,
  ConversationFeed,
  ConversationPendingMessagesReport,
} from "@sentry/junior/api/schema";

import {
  useAppendConversationMessage,
  useArchiveConversation,
  useCancelConversationPendingMessages,
  useConversationData,
  type PendingArchiveConversationUpdate,
} from "./queries";
import type { ConversationMailboxMessage } from "./conversationOutbox";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyMarkdownButton } from "./CopyMarkdownButton";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationHeaderMeta } from "./ConversationHeaderMeta";
import {
  ConversationAnnotations,
  ConversationIdentity,
  ConversationPrivacyChip,
  ConversationStats,
  hasConversationAnnotations,
  hasConversationIdentity,
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
  pendingArchiveUpdate?: PendingArchiveConversationUpdate;
}) {
  const [subagentTarget, setSubagentTarget] =
    useState<SubagentTranscriptTarget>();
  const [view, setView] = useState<TranscriptViewMode>("rich");
  const [search, setSearch] = useState("");
  const [pinRequestVersion, setPinRequestVersion] = useState(0);
  const conversationId = props.conversationId;
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
  const conversationDetail = detail.data;
  // Live polls can rebuild a large transcript tree every 2s. Defer that paint so
  // composer keystrokes stay urgent without changing visible transcript content.
  // Fall back to the latest detail on first load so the body is never blank while
  // the deferred value catches up from undefined.
  const deferredTranscript = useDeferredValue(detail.data);
  const transcript = deferredTranscript ?? detail.data;
  const visualStatus = conversation
    ? visualStatusForConversation(conversation)
    : undefined;
  // Keep live flags and mailbox chrome urgent. Only the heavy transcript body is deferred.
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
        scrollClassName="px-3 pb-1.5 md:px-7 md:pb-2"
        scroll={
          <section className="min-w-0">
            <ConversationHeader
              conversationId={conversationId}
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
              identity={
                hasConversationIdentity({
                  conversation,
                  conversationId,
                  detail: detail.data,
                }) ? (
                  <ConversationIdentity
                    conversation={conversation}
                    conversationId={conversationId}
                    detail={detail.data}
                  />
                ) : null
              }
              live={live}
              meta={
                <ConversationHeaderMeta
                  identity={
                    hasConversationIdentity({
                      conversation,
                      conversationId,
                      detail: detail.data,
                      variant: "compact",
                    }) ? (
                      <ConversationIdentity
                        conversation={conversation}
                        conversationId={conversationId}
                        detail={detail.data}
                        variant="compact"
                      />
                    ) : null
                  }
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
              onViewChange={setView}
              privacy={
                <ConversationPrivacyChip visibility={conversation?.visibility} />
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
                    Transcript refresh failed. Showing the latest available data.
                  </div>
                ) : null}
                <Transcript
                  hasPreviousPage={detail.hasPreviousPage}
                  historyError={detail.historyError}
                  historyVersion={detail.historyVersion}
                  live={live}
                  loadingPreviousPage={detail.isLoadingPreviousPage}
                  onLoadPreviousPage={detail.loadPreviousPage}
                  pinRequestVersion={pinRequestVersion}
                  responding={!detail.error && live}
                  onOpenSubagentTranscript={onOpenSubagentTranscript}
                  search={search}
                  transcript={transcript}
                  view={view}
                />
              </>
            )}
          </section>
        }
        dock={
          detail.data?.isParticipant ? (
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
    async (message: string, idempotencyKey: string) => {
      await appendMessageRef.current.mutateAsync({
        idempotencyKey,
        message,
      });
    },
    [],
  );
  const onRetry = useCallback((message: ConversationMailboxMessage) => {
    if (!message.idempotencyKey || !message.text) return;
    void appendMessageRef.current.mutateAsync({
      idempotencyKey: message.idempotencyKey,
      message: message.text,
    });
  }, []);
  const onFocus = useCallback(() => {
    onPinRequestRef.current();
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
  const onCancelMessage = useCallback((message: ConversationMailboxMessage) => {
    const receivedBefore = props.pendingGeneratedAtRef.current;
    if (!receivedBefore) return;
    cancelPendingMessagesRef.current.mutate({
      inboundMessageIds: [message.inboundMessageId],
      receivedBefore,
    });
  }, [props.pendingGeneratedAtRef]);
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
      variant="reply"
    >
      <ConversationComposer
        draftId={props.conversationId}
        label="Continue this conversation"
        submitLabel="Send"
        onFocus={onFocus}
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
      : undefined,
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
