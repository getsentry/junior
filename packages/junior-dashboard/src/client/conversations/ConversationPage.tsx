import { useCallback, useRef, useState } from "react";
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
import { Transcript } from "./TranscriptView";
import { TranscriptLoading } from "./TranscriptLoading";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "./SubagentTranscriptDrawer";
import type { Conversation, ConversationTranscript } from "../types";

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
  const visualStatus = conversation
    ? visualStatusForConversation(conversation)
    : undefined;
  // Keep live flags and transcript data on the same render. Composer isolation
  // in the reply footer is what keeps typing urgent during live polls.
  const live = conversationIsLive(visualStatus, detail.data);
  const requestPin = useCallback(() => {
    setPinRequestVersion((version) => version + 1);
  }, []);

  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[minmax(7rem,1fr)_minmax(0,auto)]">
      <div
        aria-label="Conversation transcript"
        className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 md:px-7 md:pb-5"
        tabIndex={0}
      >
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
                onOpenSubagentTranscript={({ part }) => {
                  setSubagentTarget({
                    conversationId: part.childConversationId,
                    part,
                  });
                }}
                search={search}
                transcript={detail.data}
                view={view}
              />
            </>
          )}
        </section>
      </div>
      {detail.data?.isParticipant ? (
        <ConversationReplyFooter
          conversation={detail.data}
          conversationId={conversationId}
          live={live}
          onPinRequest={requestPin}
          pendingAuthorization={detail.pendingAuthorization}
          pendingGeneratedAt={detail.pendingGeneratedAt}
          pendingMessages={detail.pendingMessages}
        />
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
 */
function ConversationReplyFooter(props: {
  conversation: ConversationTranscript;
  conversationId: string;
  live: boolean;
  onPinRequest: () => void;
  pendingAuthorization?: ConversationPendingMessagesReport["authorization"];
  pendingGeneratedAt?: string;
  pendingMessages: ConversationMailboxMessage[];
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
    cancelPendingMessagesRef.current.reset();
    onPinRequestRef.current();
  }, []);
  const cancellableMessageIds = props.pendingMessages
    .filter((message) => message.clientStatus === undefined)
    .map((message) => message.inboundMessageId);
  const pendingGeneratedAtRef = useRef(props.pendingGeneratedAt);
  pendingGeneratedAtRef.current = props.pendingGeneratedAt;
  const onCancelMessage = useCallback((message: ConversationMailboxMessage) => {
    const receivedBefore = pendingGeneratedAtRef.current;
    if (!receivedBefore) return;
    cancelPendingMessagesRef.current.mutate({
      inboundMessageIds: [message.inboundMessageId],
      receivedBefore,
    });
  }, []);
  const cancelTargetInboundMessageId =
    cancelPendingMessages.variables?.inboundMessageIds[0];
  const cancelError = Boolean(
    cancelPendingMessages.error &&
    cancelPendingMessages.variables?.inboundMessageIds.some((id) =>
      cancellableMessageIds.includes(id),
    ),
  );

  return (
    <div className="flex w-full min-h-0 max-h-[min(55dvh,24rem)] flex-col overflow-hidden self-end px-2 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] md:max-h-none md:overflow-visible md:self-auto md:px-7 md:py-4 md:pb-4">
      {/* Queue chrome may scroll; keep the composer pinned below it on mobile. */}
      <div className="min-h-0 min-w-0 shrink overflow-y-auto overscroll-contain md:overflow-visible">
        {props.live ? (
          <div className="mb-1.5 flex items-center gap-2 font-sans text-xs text-dashboard-text-muted md:hidden">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-300"
            />
            <span>Junior is working…</span>
          </div>
        ) : null}
        {props.pendingAuthorization ? (
          <PendingAuthorization authorization={props.pendingAuthorization} />
        ) : null}
        <PendingMailboxStack
          cancelError={cancelError}
          cancelPending={cancelPendingMessages.isPending}
          cancelTargetInboundMessageId={cancelTargetInboundMessageId}
          conversation={props.conversation}
          messages={props.pendingMessages}
          onCancelMessage={onCancelMessage}
          onRetry={onRetry}
        />
      </div>
      <div className="min-w-0 shrink-0">
        <ConversationComposer
          draftId={props.conversationId}
          label="Continue this conversation"
          submitLabel="Send"
          onFocus={onFocus}
          onSubmitStart={onSubmitStart}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}

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
