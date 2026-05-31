import { useParams } from "react-router";

import { useConversationData } from "../api";
import { StatusBadge } from "../components/StatusBadge";
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
import { Transcript } from "../components/Transcript";
import { TranscriptLoading } from "../components/TranscriptLoading";
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
    <div className="min-w-0 px-4 py-5 md:px-8">
      <section className="min-w-0">
        <header className="mb-6 grid gap-3 border-l-4 border-[#beaaff]/70 pl-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="m-0 text-2xl font-bold leading-tight tracking-normal">
                {conversationDisplayTitle(conversation)}
              </h2>
              <StatusBadge status={visualStatus} />
            </div>
            <div className="mt-1 break-words text-[0.88rem] leading-relaxed text-[#b8b8b8]">
              <ConversationIdentity
                conversation={conversation}
                conversationId={conversationId}
              />
            </div>
          </div>
          <div className="self-start break-words text-[0.82rem] leading-relaxed text-[#b8b8b8] md:text-right">
            updated{" "}
            {formatRelativeTime(
              conversation?.lastSeenAt ?? detail.data?.generatedAt,
            )}
          </div>
          <ConversationStats conversation={conversation} detail={detail.data} />
        </header>

        {detail.isPending ? (
          <TranscriptLoading />
        ) : detail.error ? (
          <div className="border border-white/10 bg-[#050505] p-4 text-[0.9rem] leading-relaxed text-[#b8b8b8]">
            {detail.error.message}
          </div>
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
            className="text-white no-underline hover:underline"
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
    <div className="col-span-full flex flex-wrap gap-x-3 gap-y-1 break-words text-[0.76rem] leading-[1.45] text-[#888]">
      {stats.map((value, index) => (
        <span key={`${index}-${value}`}>
          {index > 0 ? <span className="mr-3 text-[#666]">·</span> : null}
          {value}
        </span>
      ))}
    </div>
  );
}
