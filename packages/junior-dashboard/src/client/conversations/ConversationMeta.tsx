import { ObjectIcon } from "../components/ObjectIcon";
import { Badge } from "../components/ui/badge";
import { objectPresentation } from "@sentry/junior-plugin-api";
import {
  CircleDashed,
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequest,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import {
  formatConversationDuration,
  formatRelativeTime,
  formatTime,
  slackLocationLabel,
  summarizeCost,
  summarizeModelUsage,
  summarizeUsage,
  automationPath,
} from "../format";
import {
  Tooltip,
  TooltipContent,
  TooltipTitle,
  TooltipTrigger,
} from "../components/ui/tooltip";
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
import {
  linkStatusLabel,
  type ConversationLink,
} from "./ConversationLinkedWork";
import { OutboundLink } from "../components/OutboundLink";
import { MOBILE_LAYOUT_QUERY } from "../layoutMedia";

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
      <OutboundLink
        className="font-medium text-dashboard-accent-text underline decoration-dashboard-accent/40 underline-offset-2 hover:text-dashboard-accent-text"
        href={props.authorization.authorizationUrl}
      >
        {props.authorization.label}
      </OutboundLink>
      <p className="mb-0 mt-1 text-xs text-dashboard-text-muted">
        {props.authorization.completionText}
      </p>
    </div>
  );
}

/**
 * Mark a private conversation with a lock icon. Public is the default, so it
 * gets no marker, which keeps the title bar short.
 */
export function ConversationPrivacyChip(props: {
  visibility: Conversation["visibility"];
}) {
  if (props.visibility !== "private") return null;
  const label =
    "Private conversation. Only members of this conversation can see this transcript.";
  return (
    <span
      className="inline-flex items-center text-dashboard-text-muted"
      role="note"
      title={label}
    >
      <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Render plugin annotations as a newest-first stack in a conversation row. */
export function ConversationSidebarAnnotations(props: {
  annotations: ConversationDetailReport["sidebarAnnotations"] | undefined;
}) {
  const annotations = props.annotations;
  const isMobile = useIsMobileViewport();
  const [side, setSide] = useState<"top" | "bottom">("top");
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
      onOpenChange={(open, details) => {
        if (open && details.trigger) setSide(sideWithMoreRoom(details.trigger));
      }}
    >
      <TooltipTrigger
        render={
          <span
            aria-label={`Linked work, newest first: ${details.join(", ")}`}
            // Rows that are one stretched link turn off pointer events.
            // The trigger takes them back, so hover opens the tooltip.
            className="pointer-events-auto inline-flex min-w-0 max-w-full items-center"
          >
            {useMobileFacepile ? (
              <SidebarAnnotationIconFacepile
                annotations={mobileFacepileAnnotations}
                // Discs sit on the sidebar panel / row surface.
                cutoutColor="var(--color-dashboard-surface-panel)"
              />
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1">
                {badges.labeledGroups.map((group) => (
                  <SidebarAnnotationGroupChip group={group} key={group.label} />
                ))}
                {badges.overflowGroupCount > 0 ? (
                  <Badge
                    className="inline-flex h-5 min-w-7 shrink-0 items-center justify-center"
                    variant="count"
                  >
                    +{badges.overflowGroupCount}
                  </Badge>
                ) : null}
              </span>
            )}
          </span>
        }
      />
      <TooltipContent align="start" side={side}>
        <TooltipTitle>Linked work</TooltipTitle>
        {/* A row can link many items. Scroll the list so the tooltip stays on
            screen; Base UI keeps the popup open while the pointer is on it. */}
        <ul className="thin-scrollbar m-0 max-h-80 list-none space-y-1 overflow-y-auto overscroll-contain p-0 pr-1">
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
      </TooltipContent>
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
        "relative isolate inline-flex h-[18px] min-w-0 items-center",
        props.className,
      )}
    >
      <FittingIcons
        // The padding keeps the cutout rings inside the clipped row.
        className="-m-0.5 h-[22px] min-w-[22px] p-0.5"
        icons={props.annotations.map((annotation, index) => (
          <SidebarAnnotationStatusChip
            annotation={annotation}
            cutoutColor={props.cutoutColor}
            key={annotation.key}
            // Each chip to the right layers above the chip before it.
            stacked={index > 0}
            zIndex={index + 1}
          />
        ))}
        overflow={(count) => (
          <Badge
            aria-hidden="true"
            className="relative -ml-0.5 box-border inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center px-1"
            style={{
              boxShadow: `0 0 0 2px ${props.cutoutColor}`,
              zIndex: props.annotations.length + 1,
            }}
            variant="count"
          >
            +{count}
          </Badge>
        )}
      />
    </span>
  );
}

/**
 * Show the icons that fit in the row and a +N count for the rest. Icons that
 * do not fit wrap onto lines that the row clips, so the count follows the
 * real width.
 */
export function FittingIcons(props: {
  className: string;
  icons: ReactNode[];
  overflow(count: number): ReactNode;
}) {
  const rowRef = useRef<HTMLSpanElement>(null);
  const overflowRef = useRef<HTMLSpanElement>(null);
  const total = props.icons.length;
  const [shown, setShown] = useState(total);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const countFirstLine = () => {
      const items = Array.from(row.children);
      const bottom = items[0]?.getBoundingClientRect().bottom ?? 0;
      return items.filter((item) => item.getBoundingClientRect().top < bottom)
        .length;
    };
    const measure = () => {
      // Measure without the +N first. Otherwise its own width keeps the
      // last icons hidden after the row grows wide enough for all of them.
      const overflow = overflowRef.current;
      if (overflow) overflow.style.display = "none";
      const fitting = countFirstLine();
      if (overflow) overflow.style.display = "";
      setShown(fitting === total || !overflow ? fitting : countFirstLine());
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
    // Run again when `shown` changes: the +N that mounts takes width, and
    // this pass counts it before paint. The observer would run after paint.
  }, [shown, total]);

  return (
    <>
      <span
        className={cn(
          // The row gap pushes wrapped lines fully outside the clip.
          "flex flex-wrap items-center gap-y-6 overflow-hidden",
          props.className,
        )}
        ref={rowRef}
      >
        {props.icons}
      </span>
      {shown < total ? (
        <span className="contents" ref={overflowRef}>
          {props.overflow(total - shown)}
        </span>
      ) : null}
    </>
  );
}

/** One shared label with the status icons that fit and a count of the rest. */
function SidebarAnnotationGroupChip(props: {
  group: SidebarAnnotationBadgeGroup;
}) {
  return (
    // No min-w-0: a chip shrinks only to one icon and its label, so the
    // longest group gives up icons before a shorter one loses its label.
    <Badge className="inline-flex h-5 items-center gap-1" variant="count">
      <FittingIcons
        className="h-3.5 min-w-3.5 gap-x-1"
        icons={props.group.annotations.flatMap((annotation) =>
          annotation.objectType ? (
            <ObjectIcon
              {...annotation}
              // Rem, like the row: a fixed 14px icon is clipped in the row at
              // a smaller browser font size.
              className="size-3.5"
              objectType={annotation.objectType}
              key={annotation.key}
              decorative
            />
          ) : annotation.icon ? (
            <SidebarAnnotationIcon
              decorative
              icon={annotation.icon}
              key={annotation.key}
              size={11}
            />
          ) : (
            []
          ),
        )}
        overflow={(count) => (
          <span className="shrink-0 tabular-nums">+{count}</span>
        )}
      />
      <span className="max-w-40 shrink-0 truncate whitespace-nowrap">
        {props.group.label}
      </span>
    </Badge>
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

/** Open toward the taller free space, so a long list covers fewer rows. */
function sideWithMoreRoom(trigger: Element): "top" | "bottom" {
  const rect = trigger.getBoundingClientRect();
  return rect.top > window.innerHeight - rect.bottom ? "top" : "bottom";
}

function useIsMobileViewport(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined") return () => {};
      const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
      media.addEventListener("change", onStoreChange);
      return () => media.removeEventListener("change", onStoreChange);
    },
    () =>
      typeof window !== "undefined" &&
      window.matchMedia(MOBILE_LAYOUT_QUERY).matches,
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

/** The open and success green, as GitHub shows an open pull request. */
export const OPEN_TONE_CLASS = "text-[#3fb950] light:text-[#1a7f37]";
/** The attention amber. It reads on both themes, so use it for icons only. */
export const ATTENTION_TONE_CLASS = "text-[#d29922] light:text-[#9a6700]";

const SIDEBAR_ICON_PRESENTATION = {
  "circle-dot": {
    className: OPEN_TONE_CLASS,
    Icon: CircleDot,
    label: "Open",
  },
  "circle-dashed": {
    className: "text-[#8c959f] light:text-[#59636e]",
    Icon: CircleDashed,
    label: "Draft",
  },
  "circle-x": {
    className: "text-[#f85149] light:text-[#cf222e]",
    Icon: CircleX,
    label: "Closed",
  },
  "git-merge": {
    className: "text-[#a371f7] light:text-[#8250df]",
    Icon: GitMerge,
    label: "Merged",
  },
  "git-pull-request": {
    className: OPEN_TONE_CLASS,
    Icon: GitPullRequest,
    label: "Open pull request",
  },
  "triangle-alert": {
    className: ATTENTION_TONE_CLASS,
    Icon: TriangleAlert,
    label: "Needs attention",
  },
} satisfies Record<
  SidebarAnnotationIconName,
  { className: string; Icon: typeof CircleDot; label: string }
>;

/** Show a GitHub-style status icon for linked work, such as an open pull request. */
export function SidebarAnnotationIcon(props: {
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

/** Render linked work as a compact strip under the conversation title. */
export function ConversationAnnotations(props: {
  links: readonly ConversationLink[];
}) {
  return (
    <div className="flex gap-x-4 gap-y-2 overflow-x-auto">
      {props.links.map((link) => (
        <OutboundLink
          className="inline-flex min-w-0 max-w-full shrink-0 items-center gap-2 rounded-md px-1 py-0.5 font-sans text-xs leading-snug text-dashboard-text no-underline transition-colors hover:text-dashboard-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          href={link.url}
          key={link.key}
          title={[
            link.label,
            link.plugin,
            linkStatusLabel(link.status),
            link.description,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <ObjectIcon
            facts={link.facts}
            objectType={link.objectType}
            size={16}
            status={link.status}
          />
          <span className="min-w-0 break-words">{link.label}</span>
        </OutboundLink>
      ))}
    </div>
  );
}

function LocationLink(props: { label: string; locationUrl?: string }) {
  return props.locationUrl ? (
    <OutboundLink className={dashboardInlineLinkClass} href={props.locationUrl}>
      {props.label}
    </OutboundLink>
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

/** Resolve the model that an open turn last called. */
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
    if (openTurns.size > 0 && event.model) modelId = event.model.modelId;
  }
  return openTurns.size > 0 ? modelId : undefined;
}

type ConversationStatsProps = {
  conversation: Conversation | undefined;
  detail?: ConversationDetailReport;
  showUsageBreakdown?: boolean;
};

/** True when runtime stats have content to show in details. */
export function hasConversationStats(props: ConversationStatsProps): boolean {
  return conversationStatItems(props).length > 0;
}

type ConversationStatItem = {
  content: ReactNode;
  key: string;
  label: string;
  /** Shown below `md` only, where the title bar is hidden. */
  mobileOnly?: boolean;
};

/** Render runtime, source, token, and cost metadata as a labeled list. */
export function ConversationStats(props: ConversationStatsProps) {
  const stats = conversationStatItems(props);
  if (stats.length === 0) return null;
  return (
    <dl className="m-0 grid min-w-0 gap-2 text-xs leading-snug">
      {stats.map((item) => (
        <div
          className={cn(
            "flex min-w-0 items-baseline justify-between gap-4",
            item.mobileOnly && "md:hidden",
          )}
          key={item.key}
        >
          <dt className="shrink-0 text-dashboard-text-muted">{item.label}</dt>
          <dd className="m-0 min-w-0 break-words text-right tabular-nums text-dashboard-text">
            {item.content}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Name where a conversation runs, linked when the source has a URL. Returns
 * null without a location, so callers can drop the slot around it.
 */
export function conversationLocation(
  conversation: Conversation | undefined,
  detail: ConversationDetailReport | undefined,
): ReactNode {
  if (!conversation) return null;
  const location = slackLocationLabel(conversation, { includeId: false });
  if (!location) return null;
  return (
    <LocationLink
      label={location}
      locationUrl={detail?.locationUrl ?? conversation.locationUrl}
    />
  );
}

/**
 * Show the estimated cost of a conversation with its breakdown tooltip.
 * Returns null until there is a cost or a live run to show.
 */
export function conversationCost(
  conversation: Conversation | undefined,
  detail: ConversationDetailReport | undefined,
  tooltipPlacement?: "above" | "below",
): ReactNode {
  if (!conversation) return null;
  const costSummary = summarizeCost(
    detail?.cumulativeUsage ?? conversation.cumulativeUsage,
  );
  const auxiliaryCosts = detail?.auxiliaryCosts ?? conversation.auxiliaryCosts;
  const live = (detail?.status ?? conversation.status) === "active";
  if (!costSummary && !auxiliaryCosts && !live) return null;
  return (
    <CostMetric
      auxiliaryCosts={auxiliaryCosts}
      childAgentTotals={
        detail?.childAgentTotals ?? conversation.childAgentTotals
      }
      live={live}
      liveModelId={liveModelId(detail)}
      modelUsage={detail?.modelUsage}
      summary={costSummary}
      tooltipPlacement={tooltipPlacement}
    />
  );
}

function conversationStatItems(
  props: ConversationStatsProps,
): ConversationStatItem[] {
  if (!props.conversation) return [];
  const completeDetail = props.detail?.previousCursor
    ? undefined
    : props.detail;
  const usage =
    props.detail?.cumulativeUsage ?? props.conversation.cumulativeUsage;
  const tokenSummary =
    summarizeModelUsage(props.detail?.modelUsage) ?? summarizeUsage(usage);
  const durationLabel = formatConversationDuration(props.conversation);
  const live = (props.detail?.status ?? props.conversation.status) === "active";
  const activeModelId = liveModelId(props.detail);
  const sourceTask = props.detail?.sourceTask;
  const childAgentTotals =
    props.detail?.childAgentTotals ?? props.conversation.childAgentTotals;
  const lastActivityAt = props.conversation.lastSeenAt;
  const location = conversationLocation(props.conversation, props.detail);
  const cost = props.showUsageBreakdown
    ? null
    : conversationCost(props.conversation, props.detail);
  const rawStats: Array<ConversationStatItem | undefined> = [
    // The desktop title bar shows the location. Mobile hides that bar.
    location
      ? {
          content: location,
          key: "location",
          label: "Location",
          mobileOnly: true,
        }
      : undefined,
    sourceTask
      ? {
          content: <SourceTask sourceTask={sourceTask} />,
          key: "source-task",
          label: "Source",
        }
      : undefined,
    lastActivityAt
      ? {
          content: (
            <time
              dateTime={lastActivityAt}
              title={formatTime(lastActivityAt, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            >
              {formatRelativeTime(lastActivityAt)}
            </time>
          ),
          key: "last-activity",
          label: "Last activity",
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
          label: "Runtime",
        }
      : undefined,
    tokenSummary && !props.showUsageBreakdown
      ? {
          content: (
            <TokenMetric
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
          label: "Tokens",
        }
      : undefined,
    cost
      ? {
          content: cost,
          key: "cost",
          label: "Cost",
        }
      : undefined,
    childAgentTotals
      ? {
          content: <SubagentsMetric childAgentTotals={childAgentTotals} />,
          key: "subagents",
          label: "Child conversations",
        }
      : undefined,
  ];
  return rawStats.filter(
    (item): item is ConversationStatItem => item !== undefined,
  );
}
