import { useState } from "react";
import { Link } from "react-router";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { ConversationFeed } from "@sentry/junior/api/schema";

import { useConversationData } from "../api";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyMarkdownButton } from "../components/CopyMarkdownButton";
import { StatusBadge } from "../components/StatusBadge";
import {
  buildConversations,
  conversationDisplayTitle,
  conversationFromDetail,
  conversationActorLabel,
  formatConversationDuration,
  formatRelativeTime,
  formatTime,
  peoplePath,
  slackLocationLabel,
  summarizeCost,
  summarizeMessages,
  summarizeToolCalls,
  summarizeUsage,
  visualStatusForConversation,
} from "../format";
import { MetricList, type MetricListItem } from "../components/Metric";
import {
  CostMetric,
  DurationMetric,
  MessagesMetric,
  TokenMetric,
  ToolCallsMetric,
} from "../components/TelemetryMetrics";
import { Transcript } from "../components/Transcript";
import { TranscriptLoading } from "../components/TranscriptLoading";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "../components/SubagentTranscriptDrawer";
import type { Conversation } from "../types";

/** Render the selected conversation transcript inside the workspace. */
export function ConversationPage(props: {
  conversationId: string;
  data?: { conversations: ConversationFeed };
}) {
  const [subagentTarget, setSubagentTarget] =
    useState<SubagentTranscriptTarget>();
  const conversationId = props.conversationId;
  const summaries = props.data?.conversations.conversations ?? [];
  const conversations = buildConversations(summaries);
  const detail = useConversationData(conversationId);
  const feedConversation = conversations.find(
    (item) => item.id === conversationId,
  );
  const conversation = conversationFromDetail(detail.data) ?? feedConversation;
  const conversationDetail = detail.data;
  const visualStatus = conversation
    ? visualStatusForConversation(conversation)
    : undefined;

  return (
    <div className="w-full min-w-0 px-4 py-5 md:px-7 md:py-6">
      <section className="min-w-0">
        <header className="relative mb-5 grid gap-3 overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.025] p-5 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="mb-2 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
              Conversation
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="m-0 font-display text-2xl font-medium leading-tight tracking-[-0.03em] md:text-[1.75rem]">
                {conversationDisplayTitle(conversation)}
              </h2>
              <StatusBadge status={visualStatus} />
            </div>
            <div className="mt-2 break-words font-mono text-[0.68rem] leading-snug text-white/40">
              <ConversationIdentity
                conversation={conversation}
                conversationId={conversationId}
                detail={detail.data}
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-col items-start gap-2 self-start font-mono text-[0.65rem] leading-snug text-white/35 md:items-end md:text-right">
            <div className="break-words">
              updated{" "}
              {formatRelativeTime(
                conversation?.lastSeenAt ?? detail.data?.generatedAt,
              )}
            </div>
          </div>
          <ConversationStats conversation={conversation} detail={detail.data} />
        </header>

        {detail.isPending ? (
          <TranscriptLoading />
        ) : detail.error ? (
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-4 font-mono text-[0.76rem] leading-relaxed text-white/45">
            {detail.error.message}
          </div>
        ) : (
          <Transcript
            actions={
              <CopyMarkdownButton
                key={`${conversationDetail?.conversationId ?? "loading"}:${conversationDetail?.generatedAt ?? ""}`}
                getMarkdown={
                  conversationDetail
                    ? () =>
                        buildConversationMarkdown(
                          conversationDetail,
                          conversation,
                        )
                    : undefined
                }
              />
            }
            live={conversationIsLive(visualStatus, detail.data)}
            onOpenSubagentTranscript={({ part, conversation }) => {
              if (!conversationId) return;
              setSubagentTarget({ conversation, conversationId, part });
            }}
            transcript={detail.data}
          />
        )}
      </section>
      <SubagentTranscriptDrawer
        onClose={() => setSubagentTarget(undefined)}
        target={subagentTarget}
      />
    </div>
  );
}

function conversationIsLive(
  visualStatus: ReturnType<typeof visualStatusForConversation> | undefined,
  detail: ConversationDetailReport | undefined,
): boolean {
  if (detail) return detail.status === "active";
  return visualStatus === "active";
}

function ConversationIdentity(props: {
  conversation: Conversation | undefined;
  conversationId: string | undefined;
  detail: ConversationDetailReport | undefined;
}) {
  const email = props.conversation?.actorIdentity?.email?.trim();
  const owner = conversationActorLabel(props.conversation);
  const id = props.conversationId ?? props.conversation?.id;

  return (
    <>
      {owner ? (
        <>
          {email ? (
            <Link
              className="font-semibold text-[#d6d6d6] underline decoration-white/20 underline-offset-2 transition-colors hover:text-white hover:decoration-white/60"
              to={peoplePath(email)}
            >
              {owner}
            </Link>
          ) : (
            owner
          )}
          {id ? <>{" · "}</> : null}
        </>
      ) : null}
      {id ?? null}
      {props.detail?.sentryConversationUrl ? (
        <>
          {" · "}
          <a
            className="text-white no-underline hover:underline"
            href={props.detail.sentryConversationUrl}
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
  detail?: ConversationDetailReport;
}) {
  if (!props.conversation) return null;
  const messageSummary = props.detail
    ? summarizeMessages(props.detail)
    : undefined;
  const toolSummary = props.detail
    ? summarizeToolCalls(props.detail)
    : undefined;
  const usage =
    props.detail?.cumulativeUsage ?? props.conversation.cumulativeUsage;
  const tokenSummary = summarizeUsage(usage);
  const costSummary = summarizeCost(usage);
  const location = slackLocationLabel(props.conversation, {
    includeId: false,
  });
  const durationLabel = formatConversationDuration(props.conversation);
  const rawStats: Array<MetricListItem | undefined> = [
    location
      ? {
          content: location,
          key: "location",
        }
      : undefined,
    {
      content: (
        <MessagesMetric loading={!props.detail} summary={messageSummary} />
      ),
      key: "messages",
    },
    !props.detail || (toolSummary && toolSummary.total > 0)
      ? {
          content: (
            <ToolCallsMetric loading={!props.detail} summary={toolSummary} />
          ),
          key: "tools",
        }
      : undefined,
    tokenSummary
      ? {
          content: <TokenMetric summary={tokenSummary} />,
          key: "tokens",
        }
      : undefined,
    costSummary
      ? {
          content: <CostMetric summary={costSummary} />,
          key: "cost",
        }
      : undefined,
    durationLabel !== "none"
      ? {
          content: (
            <DurationMetric
              endedAt={props.conversation.lastSeenAt}
              label={durationLabel}
              startedAt={props.conversation.startedAt}
            />
          ),
          key: "duration",
        }
      : undefined,
    {
      content: `started ${formatTime(props.conversation.startedAt)}`,
      key: "started",
    },
  ];
  const stats = rawStats.filter(
    (item): item is MetricListItem => item !== undefined,
  );

  return (
    <MetricList
      className="col-span-full mt-1 break-words border-t border-white/[0.07] pt-3 text-[0.72rem] leading-[1.5] text-white/45"
      items={stats}
    />
  );
}
