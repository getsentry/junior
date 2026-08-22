import {
  CircleDashed,
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequest,
  Globe2,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";
import { useSyncExternalStore } from "react";
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
import { cn } from "../styles";
import { CostMetric, DurationMetric, TokenMetric } from "./TelemetryMetrics";
import type { Conversation } from "../types";
import {
  projectSidebarAnnotationBadges,
  type SidebarAnnotation,
  type SidebarAnnotationBadgeGroup,
} from "./sidebarAnnotationBadges";

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

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

/** Render plugin annotations as a newest-first stack in a conversation row. */
export function ConversationSidebarAnnotations(props: {
  annotations: ConversationDetailReport["sidebarAnnotations"] | undefined;
}) {
  const annotations = props.annotations;
  const isMobile = useIsMobileViewport();
  if (!annotations?.length) return null;

  const details = annotations.map((annotation) =>
    sidebarAnnotationDetail(annotation),
  );
  // Group by shared label so one label can carry many status icons. Tooltip
  // still lists every work item.
  const badges = projectSidebarAnnotationBadges(annotations);
  const mobileFacepileAnnotations =
    badges.groups.length > 1
      ? badges.groups.flatMap((group) => group.annotations)
      : [];

  return (
    <Tooltip
      align="left"
      content={
        <ul className="m-0 list-none space-y-1 p-0">
          {annotations.map((annotation, index) => (
            <li
              className="flex min-w-0 items-center gap-1.5"
              key={`${annotation.key}:${index}`}
            >
              {annotation.icon ? (
                <SidebarAnnotationIcon icon={annotation.icon} />
              ) : null}
              <span className="min-w-0 truncate">{details[index]}</span>
            </li>
          ))}
        </ul>
      }
      label="Linked work"
      triggerClassName="min-w-0"
    >
      <span
        aria-label={`Linked work, newest first: ${details.join(", ")}`}
        className="inline-flex min-w-0 max-w-full items-center"
      >
        {isMobile && mobileFacepileAnnotations.length > 1 ? (
          <SidebarAnnotationIconFacepile
            annotations={mobileFacepileAnnotations}
            // Discs sit on the sidebar panel / row surface (#09090b).
            cutoutColor="var(--color-dashboard-surface-panel)"
          />
        ) : badges.primaryGroup ? (
          <SidebarAnnotationOverflowStack
            overflowAnnotations={badges.overflowAnnotations}
            overflowGroupCount={badges.overflowGroupCount}
            primaryGroup={badges.primaryGroup}
          />
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1">
            {badges.labeledGroups.map((group) => (
              <SidebarAnnotationGroupChip
                group={group}
                key={group.label}
              />
            ))}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

/** Compact overlapping status chips used by mobile and overflow clusters. */
function SidebarAnnotationIconFacepile(props: {
  annotations: SidebarAnnotation[];
  /**
   * CSS color for the avatar-stack cutout ring. Must match the surface under
   * the facepile so lower chips read as clean silhouettes.
   */
  cutoutColor: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        // Isolate stacking context so z-index only orders chips inside the pile.
        // Extra right pad keeps the last chip's cutout ring from clipping.
        "relative isolate inline-flex h-[18px] items-center pr-0.5",
        props.className,
      )}
    >
      {props.annotations.map((annotation, index) => (
        <SidebarAnnotationStatusChip
          annotation={annotation}
          cutoutColor={props.cutoutColor}
          key={annotation.key}
          // Each chip to the right layers above the chip before it.
          stacked={index > 0}
          zIndex={index + 1}
        />
      ))}
    </span>
  );
}

/** One continuous stack: labeled group, overflow icon chips, then +N groups. */
function SidebarAnnotationOverflowStack(props: {
  primaryGroup: SidebarAnnotationBadgeGroup;
  overflowAnnotations: SidebarAnnotation[];
  overflowGroupCount: number;
}) {
  if (props.overflowGroupCount === 0) return null;
  return (
    <span className="isolate inline-flex h-5 min-w-0 items-center pr-0.5">
      <SidebarAnnotationGroupChip group={props.primaryGroup} />
      {props.overflowAnnotations.map((annotation, index) => (
        <SidebarAnnotationStatusChip
          annotation={annotation}
          cutoutColor="var(--color-dashboard-surface-panel)"
          key={annotation.key}
          stacked
          zIndex={index + 1}
        />
      ))}
      <span
        className="relative -ml-1.5 inline-flex h-5 min-w-7 shrink-0 items-center justify-center rounded-full border border-white/12 bg-dashboard-control px-1.5 font-mono text-2xs leading-none text-dashboard-text-muted"
        style={{
          boxShadow: "0 0 0 2px var(--color-dashboard-surface-panel)",
          zIndex: props.overflowAnnotations.length + 1,
        }}
      >
        +{props.overflowGroupCount}
      </span>
    </span>
  );
}

/** One shared label with every status icon for that label. */
function SidebarAnnotationGroupChip(props: {
  group: SidebarAnnotationBadgeGroup;
}) {
  return (
    <span className="inline-flex h-5 min-w-0 max-w-36 shrink-0 items-center gap-1 truncate rounded-full border border-white/10 bg-dashboard-control px-1.5 font-sans text-2xs leading-none text-dashboard-text-muted">
      {props.group.annotations.map((annotation) =>
        annotation.icon ? (
          <SidebarAnnotationIcon
            decorative
            icon={annotation.icon}
            key={annotation.key}
            size={11}
          />
        ) : null,
      )}
      <span className="min-w-0 truncate whitespace-nowrap">
        {props.group.label}
      </span>
    </span>
  );
}

/** Icon-only chip that matches labeled-chip chrome and stacks like a facepile. */
function SidebarAnnotationStatusChip(props: {
  annotation: SidebarAnnotation;
  cutoutColor: string;
  stacked?: boolean;
  zIndex: number;
}) {
  const tone = props.annotation.icon
    ? SIDEBAR_ICON_PRESENTATION[props.annotation.icon]
    : undefined;
  return (
    <span
      aria-hidden="true"
      className={cn(
        // Same border + fill language as labeled chips so the stack reads as
        // real chips, not floating glyphs. Box-shadow cutout (not border) keeps
        // layout at 18px while punching a surface-colored ring through the chip
        // underneath — classic avatar-facepile silhouette.
        "relative box-border inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-white/12 bg-dashboard-control",
        props.stacked && "-ml-2",
      )}
      style={{
        boxShadow: `0 0 0 2px ${props.cutoutColor}`,
        zIndex: props.zIndex,
      }}
      title={tone?.label}
    >
      {props.annotation.icon ? (
        <SidebarAnnotationIcon
          decorative
          icon={props.annotation.icon}
          size={11}
        />
      ) : (
        <span className="font-sans text-2xs font-semibold leading-none text-dashboard-text-muted">
          {props.annotation.label.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

function useIsMobileViewport(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined") return () => {};
      const media = window.matchMedia(MOBILE_MEDIA_QUERY);
      media.addEventListener("change", onStoreChange);
      return () => media.removeEventListener("change", onStoreChange);
    },
    () =>
      typeof window !== "undefined" &&
      window.matchMedia(MOBILE_MEDIA_QUERY).matches,
    () => false,
  );
}

function sidebarAnnotationDetail(annotation: {
  key: string;
  label: string;
}): string {
  // Prefer the plugin key when it carries a fuller resource identity than the
  // compact label (for example owner/repo#123 vs repo).
  return annotation.key.includes("/") || annotation.key.includes("#")
    ? annotation.key
    : annotation.label;
}

type SidebarAnnotationIconName = NonNullable<
  NonNullable<ConversationDetailReport["sidebarAnnotations"]>[number]["icon"]
>;

const SIDEBAR_ICON_PRESENTATION = {
  "circle-dot": { className: "text-[#3fb950]", Icon: CircleDot, label: "Open" },
  "circle-dashed": {
    className: "text-[#8c959f]",
    Icon: CircleDashed,
    label: "Draft",
  },
  "circle-x": { className: "text-[#f85149]", Icon: CircleX, label: "Closed" },
  "git-merge": { className: "text-[#a371f7]", Icon: GitMerge, label: "Merged" },
  "git-pull-request": {
    className: "text-[#3fb950]",
    Icon: GitPullRequest,
    label: "Open pull request",
  },
  "triangle-alert": {
    className: "text-[#d29922]",
    Icon: TriangleAlert,
    label: "Needs attention",
  },
} satisfies Record<
  SidebarAnnotationIconName,
  { className: string; Icon: typeof CircleDot; label: string }
>;

function SidebarAnnotationIcon(props: {
  icon: SidebarAnnotationIconName;
  size?: number;
  /** Hide accessible name when a parent already labels the control. */
  decorative?: boolean;
}) {
  const presentation = SIDEBAR_ICON_PRESENTATION[props.icon];
  const size = props.size ?? 11;
  return (
    <span
      aria-hidden={props.decorative ? true : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center leading-none",
        presentation.className,
      )}
      // Fixed box stops lucide/svg metrics from shifting chip/disc baselines.
      style={{ width: size, height: size }}
      title={props.decorative ? undefined : presentation.label}
    >
      <presentation.Icon
        aria-hidden="true"
        className="block"
        size={size}
        strokeWidth={2.25}
      />
      {props.decorative ? null : (
        <span className="sr-only">{presentation.label}</span>
      )}
    </span>
  );
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
          {link.status ? (
            <ResourceStatus status={link.status} url={link.url} />
          ) : null}
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

const RESOURCE_STATUS_ICON = {
  open: "circle-dot",
  draft: "circle-dashed",
  closed: "circle-x",
  merged: "git-merge",
  warning: "triangle-alert",
} as const satisfies Record<ResourceLinkStatus, SidebarAnnotationIconName>;

function isPullRequestUrl(url: string): boolean {
  try {
    return /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function resourceStatusIcon(
  status: ResourceLinkStatus,
  url: string,
): SidebarAnnotationIconName {
  if (status === "open" && isPullRequestUrl(url)) return "git-pull-request";
  return RESOURCE_STATUS_ICON[status];
}

function ResourceStatus(props: { status: ResourceLinkStatus; url: string }) {
  return (
    <SidebarAnnotationIcon
      icon={resourceStatusIcon(props.status, props.url)}
      size={12}
    />
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
