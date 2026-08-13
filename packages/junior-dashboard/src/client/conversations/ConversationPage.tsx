import { useState } from "react";
import type {
  ConversationDetailReport,
  ConversationFeed,
} from "@sentry/junior/api/schema";

import {
  useAppendConversationMessage,
  useArchiveConversation,
  useConversationData,
  type PendingArchiveConversationUpdate,
} from "./queries";
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
import type { Conversation } from "../types";

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
  const conversationId = props.conversationId;
  const summaries = props.data?.conversations.conversations ?? [];
  const conversations = buildConversations(summaries);
  const detail = useConversationData(conversationId);
  const archive = useArchiveConversation(conversationId);
  const appendMessage = useAppendConversationMessage(conversationId);
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

  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
      <div
        aria-label="Conversation transcript"
        className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 md:px-7 md:pb-5"
        tabIndex={0}
      >
        <section className="min-w-0">
          <ConversationHeader
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
              hasConversationAnnotations(detail.data) ? (
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
            live={conversationIsLive(visualStatus, detail.data)}
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
                live={conversationIsLive(visualStatus, detail.data)}
                loadingPreviousPage={detail.isLoadingPreviousPage}
                onLoadPreviousPage={detail.loadPreviousPage}
                responding={
                  !detail.error && conversationIsLive(visualStatus, detail.data)
                }
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
        <div className="px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:px-7 md:py-4 md:pb-4">
          {conversationIsLive(visualStatus, detail.data) ? (
            <div className="mb-1.5 flex items-center gap-2 font-sans text-xs text-dashboard-text-muted md:hidden">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-300"
              />
              <span>Junior is working…</span>
            </div>
          ) : null}
          <div className="grid min-w-0">
            {detail.pendingAuthorization ? (
              <PendingAuthorization
                authorization={detail.pendingAuthorization}
              />
            ) : null}
            {detail.data ? (
              <PendingMailboxStack
                conversation={detail.data}
                messages={detail.pendingMessages}
              />
            ) : null}
            <ConversationComposer
              draftId={conversationId}
              error={
                appendMessage.error
                  ? "Could not send the message. Try again."
                  : undefined
              }
              label="Continue this conversation"
              pending={appendMessage.isPending}
              submitLabel="Send"
              onSubmit={async (message, idempotencyKey) => {
                await appendMessage.mutateAsync({
                  idempotencyKey,
                  message,
                });
              }}
            />
          </div>
        </div>
      ) : null}
      <SubagentTranscriptDrawer
        onClose={() => setSubagentTarget(undefined)}
        target={subagentTarget}
      />
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
