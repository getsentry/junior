import { ObjectIcon } from "../components/ObjectIcon";
import { objectPresentation } from "@sentry/junior-plugin-api";
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
  formatConversationDuration,
  slackLocationLabel,
  summarizeCost,
  summarizeModelUsage,
  summarizeUsage,
  automationPath,
} from "../format";
import { Tooltip } from "../components/Tooltip";
import { MetricList, type MetricListItem } from "../components/Metric";
import { cn, dashboardInlineLinkClass } from "../styles";
import {
  CostMetric,
  DurationMetric,
  SubagentsMetric,
  TokenMetric,
} from "./TelemetryMetrics";
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
    <div className="mb-2 rounded-lg border border-dashboard-accent/20 bg-dashboard-accent/[0.07] px-3 py-2.5 font-sans text-sm text-dashboard-text">
      <a
        className="font-medium text-dashboard-accent-text underline decoration-dashboard-accent/40 underline-offset-2 hover:text-dashboard-accent-text"
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
          ? "inline-flex max-w-full items-center gap-1 rounded-full border border-dashboard-border-emphasis bg-dashboard-fill-soft px-2 py-0.5 font-sans text-2xs font-medium text-dashboard-text-muted"
          : "inline-flex max-w-full items-center gap-1 rounded-full border border-dashboard-border-strong bg-dashboard-fill-soft px-2 py-0.5 font-sans text-2xs font-medium text-dashboard-text-muted"
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
  Extract<
    NonNullable<ConversationDetailReport["annotations"]>[number],
    { kind: "resource_link" }
  >["status"]
>;

/** True when the conversation has at least one resource-link annotation. */
export function hasConversationAnnotations(
  annotations: ConversationDetailReport["annotations"] | undefined,
): boolean {
  return Boolean(annotations?.some((annotation) => Boolean(annotation.url)));
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
  // Mobile multi-label rows only: pure icon facepile. Desktop always uses
  // labeled chips (+ plain +N when more than two labels).
  const useMobileFacepile = isMobile && badges.groups.length > 1;
  const mobileFacepileAnnotations = useMobileFacepile
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
              {annotation.objectType ? (
                <ObjectIcon
                  {...annotation}
                  objectType={annotation.objectType}
                  size={14}
                />
              ) : annotation.icon ? (
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
        {useMobileFacepile ? (
          <SidebarAnnotationIconFacepile
            annotations={mobileFacepileAnnotations}
            // Discs sit on the sidebar panel / row surface (#09090b).
            cutoutColor="var(--color-dashboard-surface-panel)"
          />
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1">
            {badges.labeledGroups.map((group) => (
              <SidebarAnnotationGroupChip group={group} key={group.label} />
            ))}
            {badges.overflowGroupCount > 0 ? (
              <span className="inline-flex h-5 min-w-7 shrink-0 items-center justify-center rounded-full border border-dashboard-border-strong bg-dashboard-control px-1.5 font-sans text-2xs tabular-nums leading-none text-dashboard-text-muted">
                +{badges.overflowGroupCount}
              </span>
            ) : null}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

/** Compact overlapping status chips for mobile multi-label rows only. */
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

/** One shared label with every status icon for that label. */
function SidebarAnnotationGroupChip(props: {
  group: SidebarAnnotationBadgeGroup;
}) {
  return (
    <span className="inline-flex h-5 min-w-0 max-w-60 shrink-0 items-center gap-1 truncate rounded-full border border-dashboard-border-strong bg-dashboard-control px-1.5 font-sans text-2xs leading-none text-dashboard-text-muted">
      {props.group.annotations.map((annotation) =>
        annotation.objectType ? (
          <ObjectIcon
            {...annotation}
            objectType={annotation.objectType}
            key={annotation.key}
            decorative
            size={14}
          />
        ) : annotation.icon ? (
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

/** Icon-only chip used only by the mobile multi-label facepile. */
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
        "relative box-border inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-dashboard-border-strong bg-dashboard-control",
        props.stacked && "-ml-1",
      )}
      style={{
        boxShadow: `0 0 0 2px ${props.cutoutColor}`,
        zIndex: props.zIndex,
      }}
      title={tone?.label}
    >
      {props.annotation.objectType ? (
        <ObjectIcon
          {...props.annotation}
          objectType={props.annotation.objectType}
          decorative
          size={12}
        />
      ) : props.annotation.icon ? (
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
  objectType?: SidebarAnnotation["objectType"];
  status?: string;
}): string {
  const identity = annotation.objectType
    ? [
        objectPresentation({ objectType: annotation.objectType }).label,
        annotation.status,
      ]
        .filter(Boolean)
        .join(": ")
    : "";
  // Prefer the plugin key when it carries a fuller resource identity than the
  // compact label (for example owner/repo#123 vs repo).
  const label =
    annotation.key.includes("/") || annotation.key.includes("#")
      ? annotation.key
      : annotation.label;
  return [identity, label].filter(Boolean).join(" · ");
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
  layout?: "list" | "strip";
}) {
  const links =
    props.detail?.annotations?.filter(
      (annotation) => annotation.url !== null,
    ) ?? [];
  if (links.length === 0) return null;
  return (
    <div
      className={cn(
        "flex gap-x-4 gap-y-2",
        props.layout === "strip" ? "overflow-x-auto" : "flex-col",
      )}
    >
      {links.map((link) => (
        <a
          className={cn(
            "inline-flex min-w-0 max-w-full shrink-0 items-center gap-2 rounded-md font-sans leading-snug text-dashboard-text no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
            props.layout === "strip"
              ? "px-1 py-0.5 text-xs hover:text-dashboard-accent-text"
              : "min-h-10 border border-dashboard-border px-3 py-2 text-sm hover:border-dashboard-border-interactive hover:bg-dashboard-surface-hover",
          )}
          href={link.url ?? undefined}
          key={`${link.plugin}:${link.key}`}
          rel="noreferrer"
          target="_blank"
          title={link.kind === "object" ? link.title : resourceLinkTitle(link)}
        >
          <ObjectIcon
            objectType={
              link.objectType ??
              props.detail?.sidebarAnnotations?.find(
                (annotation) => annotation.key === link.key,
              )?.objectType ??
              "item"
            }
            status={link.status}
            facts={link.kind === "object" ? link.facts : undefined}
            size={16}
          />
          <span className="min-w-0 break-words">{link.label}</span>
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

function LocationLink(props: { label: string; locationUrl?: string }) {
  return props.locationUrl ? (
    <a
      className={dashboardInlineLinkClass}
      href={props.locationUrl}
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
  const automationId = props.sourceTask.id?.trim();
  const title = props.sourceTask.title?.trim();
  const label = title ? `Automation: ${title}` : "Automation";
  return automationId ? (
    <Link
      className={dashboardInlineLinkClass}
      to={automationPath(automationId)}
    >
      {label}
    </Link>
  ) : (
    <span>{label}</span>
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
  const tokenSummary =
    summarizeModelUsage(props.detail?.modelUsage) ?? summarizeUsage(usage);
  const costSummary = summarizeCost(usage);
  const location = slackLocationLabel(props.conversation, {
    includeId: false,
  });
  const locationUrl =
    props.detail?.locationUrl ?? props.conversation.locationUrl;
  const durationLabel = formatConversationDuration(props.conversation);
  const live = (props.detail?.status ?? props.conversation.status) === "active";
  const activeModelId = liveModelId(props.detail);
  const sourceTask = props.detail?.sourceTask;
  const childAgentTotals =
    props.detail?.childAgentTotals ?? props.conversation.childAgentTotals;
  const rawStats: Array<MetricListItem | undefined> = [
    location
      ? {
          content: <LocationLink label={location} locationUrl={locationUrl} />,
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
              childAgentTotals={childAgentTotals}
              durationMs={props.conversation.cumulativeDurationMs}
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
              detailsHint={variant === "compact"}
              childAgentTotals={childAgentTotals}
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
              detailsHint={variant === "compact"}
              auxiliaryCosts={
                props.detail?.auxiliaryCosts ??
                props.conversation.auxiliaryCosts
              }
              childAgentTotals={childAgentTotals}
              live={live}
              liveModelId={activeModelId}
              modelUsage={props.detail?.modelUsage}
              summary={costSummary}
            />
          ),
          key: "cost",
        }
      : undefined,
    childAgentTotals
      ? {
          content: <SubagentsMetric childAgentTotals={childAgentTotals} />,
          key: "subagents",
        }
      : undefined,
  ];
  return rawStats.filter((item): item is MetricListItem => item !== undefined);
}
