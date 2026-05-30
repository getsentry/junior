import { useParams } from "react-router";

import { useConversationData } from "../api";
import { ActivityIndicator } from "../components";
import {
  buildConversations,
  conversationDisplayTitle,
  formatConversationDuration,
  formatRelativeTime,
  formatTime,
  slackLocationLabel,
  turnMessageCount,
  turnToolCallCount,
  visualStatusForConversation,
} from "../format";
import { Transcript, TranscriptLoading } from "../transcript";
import type {
  Conversation,
  ConversationDetailFeed,
  DashboardData,
} from "../types";

/** Render one permalinkable conversation transcript route. */
export function ConversationPage(props: { data?: DashboardData }) {
  const routeParams = useParams();
  const conversationId = routeParams.conversationId
    ? decodeURIComponent(routeParams.conversationId)
    : undefined;
  const sessions = props.data?.sessions.sessions ?? [];
  const conversations = buildConversations(sessions);
  const conversation = conversations.find((item) => item.id === conversationId);
  const detail = useConversationData(conversationId);
  const visualStatus = conversation
    ? visualStatusForConversation(conversation)
    : undefined;

  return (
    <div className="conversation-layout">
      <section className="conversation-main">
        <div
          className={`pulse-strip ${visualStatus ? `status-${visualStatus}` : ""}`}
        >
          <div className="conversation-header-copy">
            <div className="pulse-title">
              {conversationDisplayTitle(conversation)}
            </div>
            <div className="pulse-meta">
              <ConversationIdentity
                conversation={conversation}
                conversationId={conversationId}
              />
            </div>
          </div>
          <div className="pulse-status-panel">
            <ActivityIndicator status={visualStatus} variant="full" />
            <div className="pulse-meta">
              updated{" "}
              {formatRelativeTime(
                conversation?.lastSeenAt ?? detail.data?.generatedAt,
              )}
            </div>
          </div>
          <ConversationStats conversation={conversation} detail={detail.data} />
        </div>

        {detail.isPending ? (
          <TranscriptLoading />
        ) : detail.error ? (
          <div className="transcript-empty">{detail.error.message}</div>
        ) : (
          <Transcript turns={detail.data?.turns ?? []} />
        )}
      </section>
    </div>
  );
}

function ConversationIdentity(props: {
  conversation: Conversation | undefined;
  conversationId: string | undefined;
}) {
  const id = props.conversationId ?? "missing conversation id";
  const owner =
    props.conversation?.requesterIdentity?.email ??
    props.conversation?.requester ??
    props.conversation?.requesterIdentity?.slackUserName;
  return (
    <>
      {owner ? `${owner} · ` : ""}
      {id}
      {props.conversation?.sentryConversationUrl ? (
        <>
          {" · "}
          <a
            className="inline-link"
            href={props.conversation.sentryConversationUrl}
            rel="noreferrer"
            target="_blank"
          >
            View in Sentry
          </a>
        </>
      ) : null}
    </>
  );
}

function ConversationStats(props: {
  conversation: Conversation | undefined;
  detail?: ConversationDetailFeed;
}) {
  if (!props.conversation) return null;
  const messages = props.detail
    ? props.detail.turns.reduce(
        (count, turn) => count + turnMessageCount(turn),
        0,
      )
    : undefined;
  const toolCalls = props.detail
    ? props.detail.turns.reduce(
        (count, turn) => count + turnToolCallCount(turn),
        0,
      )
    : undefined;
  const stats = [
    slackLocationLabel(props.conversation, { includeId: false }),
    `${props.conversation.turns.length} turns`,
    messages === undefined ? "messages loading" : `${messages} messages`,
    toolCalls === undefined ? "tool calls loading" : `${toolCalls} tool calls`,
    formatConversationDuration(props.conversation),
    `started ${formatTime(props.conversation.startedAt)}`,
  ].filter(Boolean);

  return (
    <div className="conversation-stats break-words font-mono text-[0.72rem] leading-[1.45] text-[var(--muted)]">
      {stats.join(" · ")}
    </div>
  );
}
