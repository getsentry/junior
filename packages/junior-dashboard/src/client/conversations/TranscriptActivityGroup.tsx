import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { Tooltip } from "../components/Tooltip";
import type { RenderedTranscriptEntry } from "./transcriptRenderModel";
import { cn } from "../styles";
import { useTranscriptSearch } from "./transcriptSearch";

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${count} ${plural}`;
}

/** True when an entry is non-message activity that can collapse between turns. */
export function isCollapsibleActivityEntry(
  entry: RenderedTranscriptEntry,
): boolean {
  if (entry.kind === "failure") return false;
  if (entry.kind === "message") return Boolean(entry.message.eventType);
  return true;
}

/** Build a uniform collapsed label for one activity group. */
export function activityGroupLabel(entries: RenderedTranscriptEntry[]): string {
  return countLabel(entries.length, "1 event", "events");
}

/** Build a breakdown of what one collapsed activity group contains. */
export function activityGroupSummary(
  entries: RenderedTranscriptEntry[],
): string {
  const toolCount = entries.filter((entry) => entry.kind === "tool").length;
  const reasoningCount = entries.filter(
    (entry) => entry.kind === "reasoning",
  ).length;
  const compactionCount = entries.filter(
    (entry) =>
      entry.kind === "context" && entry.part.event.type === "compaction",
  ).length;
  const handoffCount = entries.filter(
    (entry) => entry.kind === "context" && entry.part.event.type === "handoff",
  ).length;
  const subagentCount = entries.filter(
    (entry) => entry.kind === "subagent",
  ).length;
  const structuredCount = entries.filter(
    (entry) => entry.kind === "structured_event",
  ).length;
  const resourceEventCount = entries.filter(
    (entry) => entry.kind === "message",
  ).length;

  const parts = [
    toolCount > 0
      ? countLabel(toolCount, "1 tool call", "tool calls")
      : undefined,
    reasoningCount > 0
      ? countLabel(reasoningCount, "1 reasoning entry", "reasoning entries")
      : undefined,
    subagentCount > 0
      ? countLabel(subagentCount, "1 subagent", "subagents")
      : undefined,
    compactionCount > 0
      ? countLabel(compactionCount, "context compacted", "context compacted")
      : undefined,
    handoffCount > 0
      ? countLabel(handoffCount, "model handoff", "model handoffs")
      : undefined,
    structuredCount > 0
      ? countLabel(structuredCount, "1 structured event", "structured events")
      : undefined,
    resourceEventCount > 0
      ? countLabel(resourceEventCount, "1 resource event", "resource events")
      : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.length > 0 ? parts.join(" · ") : activityGroupLabel(entries);
}

function hasLiveActivity(entries: RenderedTranscriptEntry[]): boolean {
  return entries.some((entry) => {
    if (entry.kind === "tool") return entry.part.status === "running";
    if (entry.kind === "subagent") return entry.part.status === "running";
    return false;
  });
}

/**
 * Open only while tools/subagents are live, or when the user forced it open.
 * Completed historical activity stays collapsed so messages stay primary.
 */
export function activityGroupOpen(args: {
  hasLiveActivity: boolean;
  userOpen: boolean | null;
}): boolean {
  return args.userOpen ?? args.hasLiveActivity;
}

/** Collapse completed non-message activity so chat messages stay primary. */
export function TranscriptActivityGroup(props: {
  entries: RenderedTranscriptEntry[];
  renderEntry: (entry: RenderedTranscriptEntry) => ReactNode;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const rows = props.entries.map((entry) => (
    <Fragment key={entry.key}>{props.renderEntry(entry)}</Fragment>
  ));
  const label = activityGroupLabel(props.entries);
  const summary = activityGroupSummary(props.entries);
  const live = hasLiveActivity(props.entries);

  if (searchActive) {
    return <div className="grid min-w-0 gap-1">{rows}</div>;
  }

  const open = activityGroupOpen({
    hasLiveActivity: live,
    userOpen,
  });

  return (
    <details className="group/activity-run min-w-0" open={open}>
      <summary
        className={cn(
          "flex w-fit max-w-full cursor-pointer list-none items-center gap-1 py-0.5 text-left text-xs leading-tight text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden",
          live && "text-cyan-100/80",
        )}
        onClick={(event) => {
          event.preventDefault();
          setUserOpen(!open);
        }}
      >
        <Tooltip content={summary} placement="above">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1">
            <span className="min-w-0 truncate group-open/activity-run:hidden">
              {label}
            </span>
            <span className="hidden min-w-0 truncate group-open/activity-run:inline">
              Hide {label}
            </span>
            {live ? (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-cyan-300"
              />
            ) : null}
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 opacity-55 transition-transform group-open/activity-run:rotate-90"
              strokeWidth={2.2}
            />
          </span>
        </Tooltip>
      </summary>
      <div className="mt-1.5 grid min-w-0 gap-1">{rows}</div>
    </details>
  );
}
