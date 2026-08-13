import {
  CircleDashed,
  CircleDot,
  CircleX,
  GitMerge,
  Globe2,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import {
  conversationActorLabel,
  formatConversationDuration,
  peoplePath,
  slackLocationLabel,
  summarizeCost,
  summarizeUsage,
  taskPath,
} from "../format";
import { Tooltip } from "../components/Tooltip";
import { MetricList, type MetricListItem } from "../components/Metric";
import { CostMetric, DurationMetric, TokenMetric } from "./TelemetryMetrics";
import type { Conversation } from "../types";

/** Show a pending OAuth authorization call-to-action above the composer. */
export function PendingAuthorization(props: {
  authorization: {
    authorizationUrl: string;
    completionText: string;
    label: string;
  };
}) {
  return (
    <div className="mb-2 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.07] px-3 py-2.5 font-sans text-sm text-dashboard-text">
      <a
        className="font-medium text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-100"
        href={props.authorization.authorizationUrl}
        rel="noreferrer"
        target="_blank"
      >
        {props.authorization.label}
      </a>
      <p className="mb-0 mt-1 text-xs text-dashboard-text-muted">
        {props.authorization.completionText}
      </p>
    </div>
  );
}

/** Show whether the selected conversation is public or private. */
export function ConversationPrivacyChip(props: {
  visibility: Conversation["visibility"];
}) {
  if (!props.visibility) return null;
  const isPublic = props.visibility === "public";
  const Icon = isPublic ? Globe2 : LockKeyhole;
  const shortLabel = isPublic ? "Public" : "Private";
  const fullLabel = isPublic ? "Public conversation" : "Private conversation";
  const detail = isPublic
    ? "Anyone in this workspace can see this transcript."
    : "Only members of this conversation can see this transcript.";
  return (
    <span
      className={
        isPublic
          ? "inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-300/[0.08] px-2 py-0.5 font-sans text-2xs font-medium text-emerald-50/85"
          : "inline-flex max-w-full items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 font-sans text-2xs font-medium text-dashboard-text-muted"
      }
      role="note"
      title={`${fullLabel}. ${detail}`}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span aria-hidden="true" className="truncate">
        {shortLabel}
      </span>
      <span className="sr-only">
        {fullLabel}. {detail}
      </span>
    </span>
  );
}

type ResourceLinkStatus = NonNullable<
  NonNullable<ConversationDetailReport["annotations"]>[number]["status"]
>;

/** True when the conversation has at least one resource-link annotation. */
export function hasConversationAnnotations(
  annotations: ConversationDetailReport["annotations"] | undefined,
): boolean {
  return Boolean(
    annotations?.some((annotation) => annotation.kind === "resource_link"),
  );
}

type SidebarAnnotation = NonNullable<
  NonNullable<ConversationDetailReport["annotations"]>[number]["sidebar"]
> & { status?: ResourceLinkStatus };

const SIDEBAR_STATUS_RANK: Record<ResourceLinkStatus, number> = {
  warning: 5,
  open: 4,
  draft: 3,
  merged: 2,
  closed: 1,
};

function preferredSidebarStatus(
  current: ResourceLinkStatus | undefined,
  candidate: ResourceLinkStatus | undefined,
): ResourceLinkStatus | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return SIDEBAR_STATUS_RANK[candidate] > SIDEBAR_STATUS_RANK[current]
    ? candidate
    : current;
}

/** Group plugin-owned annotation summaries for a conversation row. */
export function conversationSidebarAnnotations(
  annotations: ConversationDetailReport["annotations"] | undefined,
): SidebarAnnotation[] {
  const groups = new Map<
    string,
    {
      labels: Set<string>;
      pluralLabel: string;
      status?: ResourceLinkStatus;
    }
  >();
  for (const annotation of annotations ?? []) {
    if (!annotation.sidebar) continue;
    const current = groups.get(annotation.sidebar.group);
    if (current) {
      current.labels.add(annotation.sidebar.label);
      current.status = preferredSidebarStatus(
        current.status,
        annotation.status,
      );
    } else {
      groups.set(annotation.sidebar.group, {
        labels: new Set([annotation.sidebar.label]),
        pluralLabel: annotation.sidebar.pluralLabel,
        status: annotation.status,
      });
    }
  }
  return [...groups.entries()].map(([group, summary]) => ({
    group,
    label:
      summary.labels.size === 1
        ? [...summary.labels][0]!
        : `${summary.labels.size} ${summary.pluralLabel}`,
    pluralLabel: summary.pluralLabel,
    status: summary.status,
  }));
}

/** Render compact plugin-owned annotation summaries in a conversation row. */
export function ConversationSidebarAnnotations(props: {
  annotations: ConversationDetailReport["annotations"] | undefined;
}) {
  const summaries = conversationSidebarAnnotations(props.annotations);
  if (summaries.length === 0) return null;
  return summaries.map((summary) => (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 truncate"
      key={summary.group}
      title={summary.label}
    >
      {summary.status ? (
        <ResourceStatus size={11} status={summary.status} />
      ) : null}
      <span className="truncate text-dashboard-text-muted">
        {summary.label}
      </span>
    </span>
  ));
}

/** Render resource-link annotations under the conversation title. */
export function ConversationAnnotations(props: {
  detail: ConversationDetailReport | undefined;
}) {
  const links =
    props.detail?.annotations?.filter(
      (annotation) => annotation.kind === "resource_link",
    ) ?? [];
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((link) => (
        <a
          className="inline-flex items-center gap-1.5 rounded border border-cyan-300/15 bg-cyan-300/[0.055] px-2 py-0.5 font-sans text-2xs leading-snug text-cyan-50 no-underline"
          href={link.url}
          key={`${link.plugin}:${link.key}`}
          rel="noreferrer"
          target="_blank"
          title={resourceLinkTitle(link)}
        >
          {link.status ? <ResourceStatus status={link.status} /> : null}
          <span>{link.label}</span>
        </a>
      ))}
    </div>
  );
}

function resourceLinkTitle(link: {
  description?: string;
  label: string;
  plugin: string;
  status?: ResourceLinkStatus;
}): string {
  const statusLabel = link.status
    ? {
        open: "Open",
        draft: "Draft",
        closed: "Closed",
        merged: "Merged",
        warning: "Needs attention",
      }[link.status]
    : undefined;
  return [link.label, link.plugin, statusLabel, link.description]
    .filter(Boolean)
    .join(" · ");
}

function ResourceStatus(props: {
  size?: number;
  status: ResourceLinkStatus;
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
      <status.Icon
        aria-hidden="true"
        size={props.size ?? 12}
        strokeWidth={2.25}
      />
      <span className="sr-only">{status.label}</span>
    </span>
  );
}

/** True when identity has content for the requested presentation. */
export function hasConversationIdentity(props: {
  conversation: Conversation | undefined;
  conversationId: string | undefined;
  detail: ConversationDetailReport | undefined;
  variant?: "compact" | "full";
}): boolean {
  const variant = props.variant ?? "full";
  const owner = conversationActorLabel(props.conversation);
  if (variant === "compact") return Boolean(owner);
  const id = props.conversationId ?? props.conversation?.id;
  return Boolean(owner || id || props.detail?.sentryConversationUrl);
}

/** Render the conversation owner, optionally with id and Sentry deep link. */
export function ConversationIdentity(props: {
  conversation: Conversation | undefined;
  conversationId: string | undefined;
  detail: ConversationDetailReport | undefined;
  variant?: "compact" | "full";
}) {
  if (!hasConversationIdentity(props)) return null;
  const variant = props.variant ?? "full";
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
  if (variant === "compact") {
    return (
      <span className="inline-flex min-w-0 max-w-full items-center">
        <span className="min-w-0 max-w-full truncate">{ownerNode}</span>
      </span>
    );
  }
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
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-1">
      {ownerNode ? (
        <span className="min-w-0 max-w-full truncate">{ownerNode}</span>
      ) : null}
      {id ? (
        <span className="inline-flex min-w-0 items-center gap-x-1.5" title={id}>
          {ownerNode ? (
            <span className="text-dashboard-text-muted/50">·</span>
          ) : null}
          <span className="min-w-0 max-w-[18rem] truncate">{id}</span>
        </span>
      ) : null}
      {sentryLink ? (
        <span className="inline-flex min-w-0 items-center gap-x-1.5">
          {ownerNode || id ? (
            <span className="text-dashboard-text-muted/50">·</span>
          ) : null}
          {sentryLink}
        </span>
      ) : null}
    </span>
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

function SourceTask(props: {
  sourceTask: NonNullable<ConversationDetailReport["sourceTask"]>;
}) {
  const kindLabel =
    props.sourceTask.kind === "scheduled" ? "Scheduled Task" : "Event Task";
  const label = props.sourceTask.label?.trim();
  const taskId = props.sourceTask.id?.trim();
  const title = props.sourceTask.title?.trim();
  const link = taskId ? (
    <Link
      className="text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60"
      to={taskPath(taskId)}
    >
      Triggered by {kindLabel}
    </Link>
  ) : (
    <span>Triggered by {kindLabel}</span>
  );
  if (!label && !title) return link;
  return (
    <Tooltip
      align="left"
      content={
        <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {title ? (
            <>
              <span>Title</span>
              <span className="text-dashboard-text">{title}</span>
            </>
          ) : null}
          {label ? (
            <>
              <span>Instruction</span>
              <span className="text-dashboard-text">{label}</span>
            </>
          ) : null}
          {taskId ? (
            <>
              <span>ID</span>
              <span className="break-all text-dashboard-text">{taskId}</span>
            </>
          ) : null}
        </span>
      }
    >
      {link}
    </Tooltip>
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

/** True when runtime stats have content for the requested presentation. */
export function hasConversationStats(props: {
  conversation: Conversation | undefined;
  detail?: ConversationDetailReport;
  variant?: "compact" | "full";
}): boolean {
  return conversationStatItems(props).length > 0;
}

/** Render runtime, source, token, and cost metadata under the conversation title. */
export function ConversationStats(props: {
  conversation: Conversation | undefined;
  detail?: ConversationDetailReport;
  variant?: "compact" | "full";
}) {
  const stats = conversationStatItems(props);
  if (stats.length === 0) return null;

  return (
    <MetricList
      className="break-words text-xs leading-[1.45] text-dashboard-text-muted"
      items={stats}
    />
  );
}

function conversationStatItems(props: {
  conversation: Conversation | undefined;
  detail?: ConversationDetailReport;
  variant?: "compact" | "full";
}): MetricListItem[] {
  if (!props.conversation) return [];
  const variant = props.variant ?? "full";
  const completeDetail = props.detail?.previousCursor
    ? undefined
    : props.detail;
  const usage =
    props.detail?.cumulativeUsage ?? props.conversation.cumulativeUsage;
  const tokenSummary = summarizeUsage(usage);
  const costSummary = summarizeCost(usage);
  const location = slackLocationLabel(props.conversation, {
    includeId: false,
  });
  const sourceUrl = props.detail?.sourceUrl ?? props.conversation.sourceUrl;
  const durationLabel = formatConversationDuration(props.conversation);
  const live = (props.detail?.status ?? props.conversation.status) === "active";
  const activeModelId = liveModelId(props.detail);
  const sourceTask = props.detail?.sourceTask;
  const rawStats: Array<MetricListItem | undefined> = [
    variant === "full" && location
      ? {
          content: <SourceLocation label={location} sourceUrl={sourceUrl} />,
          key: "location",
        }
      : undefined,
    variant === "full" && sourceTask
      ? {
          content: <SourceTask sourceTask={sourceTask} />,
          key: "source-task",
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
  ];
  return rawStats.filter((item): item is MetricListItem => item !== undefined);
}
