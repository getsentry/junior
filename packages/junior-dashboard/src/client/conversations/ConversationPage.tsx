import { useState } from "react";
import {
  CircleDashed,
  CircleDot,
  CircleX,
  GitMerge,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { ConversationFeed } from "@sentry/junior/api/schema";

import {
  useArchiveConversation,
  useConversationData,
  type PendingArchiveConversationUpdate,
} from "./queries";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyMarkdownButton } from "./CopyMarkdownButton";
import {
  buildConversations,
  conversationDisplayTitle,
  conversationFromDetail,
  conversationActorLabel,
  formatConversationDuration,
  formatRelativeTime,
  peoplePath,
  slackLocationLabel,
  summarizeCost,
  summarizeTurns,
  summarizeToolCalls,
  summarizeUsage,
  visualStatusForConversation,
} from "../format";
import { Button } from "../components/Button";
import { Card } from "../components/layout/Card";
import { MetricList, type MetricListItem } from "../components/Metric";
import {
  CostMetric,
  DurationMetric,
  TurnsMetric,
  TokenMetric,
  ToolCallsMetric,
} from "./TelemetryMetrics";
import { Transcript } from "./TranscriptView";
import { TranscriptLoading } from "./TranscriptLoading";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "./SubagentTranscriptDrawer";
import type { Conversation } from "../types";

/** Render the selected conversation transcript inside the workspace. */
export function ConversationPage(props: {
  conversationId: string;
  data?: { conversations: ConversationFeed };
  pendingArchiveUpdate?: PendingArchiveConversationUpdate;
}) {
  const [subagentTarget, setSubagentTarget] =
    useState<SubagentTranscriptTarget>();
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

  return (
    <div className="w-full min-w-0 px-3 py-3 md:px-7 md:py-6">
      <section className="min-w-0">
        <Card className="relative mb-3 grid gap-2 border-white/[0.07] bg-white/[0.025] p-3 md:mb-5 md:grid-cols-[minmax(0,1fr)_auto] md:gap-3 md:p-5">
          <div className="min-w-0">
            <div className="min-w-0">
              <h2 className="m-0 line-clamp-2 font-display text-xl font-medium leading-tight tracking-[-0.03em] md:line-clamp-none md:truncate md:text-3xl">
                {conversationDisplayTitle(conversation)}
              </h2>
            </div>
            <div className="mt-1.5 min-w-0 font-mono text-xs leading-snug text-dashboard-text-muted md:mt-2">
              <ConversationIdentity
                conversation={conversation}
                conversationId={conversationId}
                detail={detail.data}
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-2 self-start font-mono text-xs leading-snug text-dashboard-text-muted md:flex-col md:items-end md:text-right">
            <div className="break-words">
              updated{" "}
              {formatRelativeTime(
                conversation?.lastSeenAt ?? detail.data?.generatedAt,
              )}
            </div>
            <Button
              className="h-auto px-2.5 py-1 text-xs font-normal text-dashboard-text-muted"
              disabled={!conversation || archive.isPending}
              onClick={() =>
                archive.mutate({
                  archived: !conversation?.archivedAt,
                  lastSeenAt: conversation!.lastSeenAt,
                })
              }
              type="button"
            >
              {archive.isPending
                ? "Saving…"
                : conversation?.archivedAt
                  ? "Unarchive"
                  : "Archive"}
            </Button>
            {archive.error ? (
              <div className="basis-full text-red-300/80 md:basis-auto">
                Could not update archive state.
              </div>
            ) : null}
          </div>
          <ConversationStats conversation={conversation} detail={detail.data} />
          <ConversationAnnotations detail={detail.data} />
        </Card>

        {detail.isPending ? (
          <TranscriptLoading />
        ) : detail.error && !detail.data ? (
          <Card className="border-white/[0.07] bg-white/[0.025] p-4 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            {detail.error.message}
          </Card>
        ) : (
          <>
            {detail.error ? (
              <div className="mb-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.045] px-4 py-2 font-mono text-xs text-amber-100/65">
                Transcript refresh failed. Showing the latest available data.
              </div>
            ) : null}
            <Transcript
              actions={
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
              transcript={detail.data}
            />
          </>
        )}
      </section>
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

function ConversationAnnotations(props: {
  detail: ConversationDetailReport | undefined;
}) {
  const links = props.detail?.annotations?.filter(
    (annotation) => annotation.kind === "resource_link",
  );
  if (!links?.length) return null;
  return (
    <div className="md:col-span-2">
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <a
            className="inline-flex items-center gap-1.5 rounded border border-cyan-300/15 bg-cyan-300/[0.055] px-2 py-1 font-mono text-xs leading-snug text-cyan-50 no-underline"
            href={link.url}
            key={`${link.plugin}:${link.key}`}
            rel="noreferrer"
            target="_blank"
          >
            {link.status ? <ResourceStatus status={link.status} /> : null}
            <span>{link.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function ResourceStatus(props: {
  status: "open" | "draft" | "closed" | "merged" | "warning";
}) {
  const status = {
    open: {
      className: "text-[#3fb950]",
      Icon: CircleDot,
      label: "Open",
    },
    draft: {
      className: "text-[#8c959f]",
      Icon: CircleDashed,
      label: "Draft",
    },
    closed: {
      className: "text-[#f85149]",
      Icon: CircleX,
      label: "Closed",
    },
    merged: {
      className: "text-[#a371f7]",
      Icon: GitMerge,
      label: "Merged",
    },
    warning: {
      className: "text-[#d29922]",
      Icon: TriangleAlert,
      label: "Needs attention",
    },
  }[props.status];

  return (
    <span className={status.className} title={status.label}>
      <status.Icon aria-hidden="true" size={12} strokeWidth={2.25} />
      <span className="sr-only">{status.label}</span>
    </span>
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
  const ownerNode = owner ? (
    email ? (
      <Link
        className="font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-white/60"
        to={peoplePath(email)}
      >
        {owner}
      </Link>
    ) : (
      owner
    )
  ) : null;
  const sentryLink = props.detail?.sentryConversationUrl ? (
    <a
      className="text-dashboard-text no-underline hover:underline"
      href={props.detail.sentryConversationUrl}
      rel="noreferrer"
      target="_blank"
    >
      View in Sentry
    </a>
  ) : null;

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 md:hidden">
        {ownerNode ? (
          <span className="min-w-0 max-w-full truncate">{ownerNode}</span>
        ) : null}
        {sentryLink ? (
          <>
            {ownerNode ? (
              <span className="text-dashboard-text-muted">·</span>
            ) : null}
            {sentryLink}
          </>
        ) : null}
      </div>
      <div className="hidden min-w-0 break-words md:block">
        {ownerNode}
        {ownerNode && id ? <>{" · "}</> : null}
        {id ? (
          <span className="break-all" title={id}>
            {id}
          </span>
        ) : null}
        {sentryLink ? (
          <>
            {" · "}
            {sentryLink}
          </>
        ) : null}
      </div>
    </>
  );
}

function SourceLocation(props: { label: string; sourceUrl?: string }) {
  return props.sourceUrl ? (
    <a
      className="text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60"
      href={props.sourceUrl}
      rel="noreferrer"
      target="_blank"
    >
      {props.label}
    </a>
  ) : (
    props.label
  );
}

/** Resolve the model still running an open turn, including mid-turn handoffs. */
export function liveModelId(
  detail: ConversationDetailReport | undefined,
): string | undefined {
  if (!detail) return undefined;
  const openTurns = new Set<string>();
  let modelId: string | undefined;
  for (const event of detail.events) {
    const data = event.data;
    if (data.type === "turn_lifecycle") {
      if (data.state === "started") openTurns.add(data.turnId);
      else openTurns.delete(data.turnId);
      if (openTurns.size === 0) modelId = undefined;
      continue;
    }
    if (openTurns.size === 0) continue;
    if (data.type === "turn_routed" && openTurns.has(data.turnId)) {
      modelId = data.modelId;
      continue;
    }
    if (data.type === "handoff") modelId = data.modelId;
  }
  return openTurns.size > 0 ? modelId : undefined;
}

function ConversationStats(props: {
  conversation: Conversation | undefined;
  detail?: ConversationDetailReport;
}) {
  if (!props.conversation) return null;
  const completeDetail = props.detail?.previousCursor
    ? undefined
    : props.detail;
  const turnSummary = completeDetail
    ? summarizeTurns(completeDetail)
    : undefined;
  const toolSummary = completeDetail
    ? summarizeToolCalls(completeDetail)
    : undefined;
  const usage =
    props.detail?.cumulativeUsage ?? props.conversation.cumulativeUsage;
  const tokenSummary = summarizeUsage(usage);
  const costSummary = summarizeCost(usage);
  const location = slackLocationLabel(props.conversation, {
    includeId: false,
  });
  const sourceUrl = props.detail?.sourceUrl ?? props.conversation.sourceUrl;
  const durationLabel = formatConversationDuration(props.conversation);
  const live =
    (props.detail?.status ?? props.conversation.status) === "active";
  const activeModelId = liveModelId(props.detail);
  const rawStats: Array<MetricListItem | undefined> = [
    location
      ? {
          content: <SourceLocation label={location} sourceUrl={sourceUrl} />,
          key: "location",
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
    tokenSummary
      ? {
          content: (
            <TokenMetric
              compactionCount={
                completeDetail
                  ? completeDetail.events.filter(
                      (event) => event.data.type === "compaction",
                    ).length
                  : undefined
              }
              live={live}
              liveModelId={activeModelId}
              modelUsage={props.detail?.modelUsage}
              summary={tokenSummary}
            />
          ),
          key: "tokens",
        }
      : undefined,
    costSummary ||
    props.detail?.auxiliaryCosts ||
    props.conversation.auxiliaryCosts ||
    live
      ? {
          content: (
            <CostMetric
              auxiliaryCosts={
                props.detail?.auxiliaryCosts ??
                props.conversation.auxiliaryCosts
              }
              live={live}
              liveModelId={activeModelId}
              modelUsage={props.detail?.modelUsage}
              summary={costSummary}
            />
          ),
          key: "cost",
        }
      : undefined,
    !props.detail || turnSummary
      ? {
          content: (
            <TurnsMetric loading={!props.detail} summary={turnSummary} />
          ),
          key: "turns",
        }
      : undefined,
    !props.detail || (toolSummary && toolSummary.total > 0)
      ? {
          content: (
            <ToolCallsMetric
              live={live}
              loading={!props.detail}
              summary={toolSummary}
            />
          ),
          key: "tools",
        }
      : undefined,
  ];
  const stats = rawStats.filter(
    (item): item is MetricListItem => item !== undefined,
  );

  return (
    <div className="col-span-full mt-1 border-t border-white/[0.07] pt-3">
      <MetricList
        className="break-words text-xs leading-[1.5] text-dashboard-text-muted"
        items={stats}
      />
    </div>
  );
}
