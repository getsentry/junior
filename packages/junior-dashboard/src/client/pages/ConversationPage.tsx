import { useState } from "react";
import { Link, useParams } from "react-router";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { useConversationData } from "../api";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyMarkdownButton } from "../components/CopyMarkdownButton";
import { ExecutionSignature } from "../components/ExecutionSignature";
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
import type { Conversation, DashboardData } from "../types";

/** Render one permalinkable conversation transcript route. */
export function ConversationPage(props: { data?: DashboardData }) {
  const [subagentTarget, setSubagentTarget] =
    useState<SubagentTranscriptTarget>();
  const routeParams = useParams();
  const conversationId = routeParams.conversationId
    ? decodeURIComponent(routeParams.conversationId)
    : undefined;
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
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      <section className="min-w-0">
        <header className="mb-3 grid gap-2 border-l-4 border-[#beaaff]/70 pl-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="m-0 text-2xl font-bold leading-tight tracking-normal">
                {conversationDisplayTitle(conversation)}
              </h2>
              <StatusBadge status={visualStatus} />
              <ExecutionSignature
                modelId={conversationDetail?.modelId}
                reasoningLevel={conversationDetail?.reasoningLevel}
              />
            </div>
            <div className="mt-1 break-words text-[0.86rem] leading-snug text-[#b8b8b8]">
              <ConversationIdentity
                conversation={conversation}
                conversationId={conversationId}
                detail={detail.data}
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-col items-start gap-2 self-start text-[0.8rem] leading-snug text-[#b8b8b8] md:items-end md:text-right">
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
          <div className="border border-white/10 bg-[#050505] p-4 text-[0.9rem] leading-relaxed text-[#b8b8b8]">
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
      className="col-span-full break-words text-[0.76rem] leading-[1.45] text-[#888]"
      items={stats}
    />
  );
}
