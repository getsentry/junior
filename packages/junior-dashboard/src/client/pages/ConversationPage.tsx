import { useEffect, useState, type ReactNode } from "react";
import { Bot, Check, Copy, Wrench } from "lucide-react";
import { useParams } from "react-router";

import { useConversationData } from "../api";
import { buildConversationMarkdown } from "../markdownExport";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import {
  buildConversations,
  conversationIdentityMeta,
  conversationDisplayTitle,
  formatConversationDuration,
  formatRelativeTime,
  formatTime,
  slackLocationLabel,
  summarizeMessages,
  summarizeToolCalls,
  summarizeUsage,
  visualStatusForConversation,
} from "../format";
import { MetricList, type MetricListItem } from "../components/Metric";
import {
  DurationMetric,
  MessagesMetric,
  TokenMetric,
  ToolCallsMetric,
} from "../components/TelemetryMetrics";
import { Transcript } from "../components/Transcript";
import { TranscriptLoading } from "../components/TranscriptLoading";
import type {
  ConversationActivity,
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
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-5 md:px-8">
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
          <div className="flex min-w-0 flex-col items-start gap-2 self-start text-[0.82rem] leading-relaxed text-[#b8b8b8] md:items-end md:text-right">
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
          <>
            <ActivityTimeline turns={detail.data?.runs ?? []} />
            <Transcript
              actions={
                <CopyMarkdownButton
                  conversation={conversation}
                  detail={detail.data}
                />
              }
              live={conversationIsLive(visualStatus, detail.data)}
              turns={detail.data?.runs ?? []}
            />
          </>
        )}
      </section>
    </div>
  );
}

function ActivityTimeline(props: {
  turns: NonNullable<ConversationDetailFeed["runs"]>;
}) {
  const activity = props.turns.flatMap((turn) =>
    (turn.activity ?? []).map((item) => ({ ...item, turnId: turn.id })),
  );
  if (activity.length === 0) return null;

  return (
    <section
      aria-label="Execution activity"
      className="mb-5 grid min-w-0 gap-2 border border-white/10 bg-white/[0.025] p-3"
    >
      <div className="text-[0.82rem] font-bold uppercase tracking-normal text-[#b8b8b8]">
        Execution Activity
      </div>
      <div className="grid min-w-0 gap-2">
        {activity.map((item) => (
          <ActivityRow
            activity={item}
            key={`${item.turnId}:${item.type}:${item.id}`}
          />
        ))}
      </div>
    </section>
  );
}

function ActivityRow(props: { activity: ConversationActivity }) {
  if (props.activity.type === "tool_execution") {
    const meta = [
      props.activity.status,
      formatTime(props.activity.createdAt),
      props.activity.toolCallId,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <ActivityRowShell
        icon={Wrench}
        label={props.activity.toolName}
        meta={meta}
      >
        {props.activity.subagents.length > 0 ? (
          <div className="mt-2 grid min-w-0 gap-1">
            {props.activity.subagents.map((subagent) => (
              <ActivityRow activity={subagent} key={subagent.id} />
            ))}
          </div>
        ) : null}
      </ActivityRowShell>
    );
  }

  const meta = [
    props.activity.status,
    formatTime(props.activity.createdAt),
    props.activity.parentToolCallId
      ? `parent ${props.activity.parentToolCallId}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ActivityRowShell
      icon={Bot}
      label={`${props.activity.subagentKind} subagent`}
      meta={meta}
    />
  );
}

function ActivityRowShell(props: {
  children?: ReactNode;
  icon: typeof Bot;
  label: string;
  meta: string;
}) {
  const Icon = props.icon;
  return (
    <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2 border-l-2 border-[#beaaff]/35 py-1 pl-2">
      <Icon
        aria-hidden="true"
        className="mt-0.5 text-[#beaaff]"
        size={14}
        strokeWidth={2}
      />
      <div className="min-w-0">
        <div className="break-words text-[0.86rem] font-semibold leading-snug text-[#f4f4f4]">
          {props.label}
        </div>
        <div className="break-words text-[0.75rem] leading-relaxed text-[#888]">
          {props.meta}
        </div>
        {props.children}
      </div>
    </div>
  );
}

function conversationIsLive(
  visualStatus: ReturnType<typeof visualStatusForConversation> | undefined,
  detail: ConversationDetailFeed | undefined,
): boolean {
  if (detail) return detail.runs.some((turn) => turn.status === "active");
  return visualStatus === "active";
}

function CopyMarkdownButton(props: {
  conversation: Conversation | undefined;
  detail: ConversationDetailFeed | undefined;
}) {
  const [status, setStatus] = useState<"copied" | "failed" | "idle">("idle");
  const disabled = !props.detail;
  const label =
    status === "copied"
      ? "Copied"
      : status === "failed"
        ? "Copy failed"
        : "Copy as Markdown";
  const Icon = status === "copied" ? Check : Copy;

  useEffect(() => {
    setStatus("idle");
  }, [props.detail?.conversationId, props.detail?.generatedAt]);

  async function copyMarkdown() {
    if (!props.detail) return;

    try {
      await navigator.clipboard.writeText(
        buildConversationMarkdown(props.detail, props.conversation),
      );
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <Button
      aria-label={label}
      disabled={disabled}
      onClick={() => void copyMarkdown()}
      size="icon"
      title={label}
    >
      <Icon aria-hidden="true" size={15} strokeWidth={2} />
    </Button>
  );
}

function ConversationIdentity(props: {
  conversation: Conversation | undefined;
  conversationId: string | undefined;
}) {
  return (
    <>
      {conversationIdentityMeta(props.conversation, props.conversationId)}
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
  const messageSummary = props.detail
    ? summarizeMessages(props.detail.runs)
    : undefined;
  const toolSummary = props.detail
    ? summarizeToolCalls(props.detail.runs)
    : undefined;
  const tokenSummary = summarizeUsage(
    (props.detail?.runs ?? props.conversation.runs).map(
      (turn) => turn.cumulativeUsage,
    ),
  );
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
