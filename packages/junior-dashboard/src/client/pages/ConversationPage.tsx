import { useParams } from "react-router";

import { useConversationData } from "../api";
import { StatusBadge } from "../components";
import { cn } from "../styles";
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
    <div className="min-w-0 px-4 py-4 md:px-8">
      <section className="min-w-0">
        <div
          className={cn(
            "mb-4 grid items-stretch gap-3 border border-l-4 border-white/10 bg-[#0b0b0b] p-4 md:grid-cols-[minmax(0,1fr)_auto]",
            visualStatus === "active" && "border-l-emerald-400",
            visualStatus === "hung" && "border-l-amber-400",
            visualStatus === "failed" && "border-l-rose-400",
            (!visualStatus || visualStatus === "idle") && "border-l-white/25",
          )}
        >
          <div className="grid min-w-0 content-between gap-1">
            <div className="text-lg font-bold leading-tight">
              {conversationDisplayTitle(conversation)}
            </div>
            <div className="break-words font-mono text-[0.82rem] leading-relaxed text-[#b8b8b8]">
              <ConversationIdentity
                conversation={conversation}
                conversationId={conversationId}
              />
            </div>
          </div>
          <div className="grid min-w-48 content-between justify-items-end gap-2 max-md:min-w-0 max-md:justify-items-stretch">
            <div className="flex justify-end max-md:justify-start">
              <StatusBadge status={visualStatus} />
            </div>
            <div className="break-words text-right font-mono text-[0.82rem] leading-relaxed text-[#b8b8b8] max-md:text-left">
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
          <div className="border border-white/10 bg-[#050505] p-4 font-mono text-[0.88rem] leading-relaxed text-[#b8b8b8]">
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
    <div className="col-span-full break-words border-t border-white/10 pt-3 font-mono text-[0.72rem] leading-[1.45] text-[#888]">
      {stats.join(" · ")}
    </div>
  );
}
