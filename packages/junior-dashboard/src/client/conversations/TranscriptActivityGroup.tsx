import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { ShimmerText } from "../components/ShimmerText";
import { Tooltip } from "../components/Tooltip";
import { formatMs } from "../format";
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
  // Delivered files are human-facing media, not collapsible tool chrome.
  if (entry.kind === "attachments_delivered") return false;
  if (entry.kind === "message") return Boolean(entry.message.eventType);
  return true;
}

function entryStartMs(entry: RenderedTranscriptEntry): number | undefined {
  if (entry.kind === "tool") {
    return entry.part.startedTimestamp ?? entry.timestamp;
  }
  if (entry.kind === "message") return entry.message.timestamp;
  return entry.timestamp;
}

function entryEndMs(entry: RenderedTranscriptEntry): number | undefined {
  if (entry.kind === "tool") {
    return entry.part.resultTimestamp ?? entry.timestamp;
  }
  if (entry.kind === "message") return entry.message.timestamp;
  return entry.timestamp;
}

/** Span one activity group from the earliest start to the latest end. */
export function activityGroupDurationMs(
  entries: RenderedTranscriptEntry[],
): number | undefined {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const entry of entries) {
    const start = entryStartMs(entry);
    const end = entryEndMs(entry);
    if (typeof start === "number" && Number.isFinite(start)) {
      startedAt = startedAt === undefined ? start : Math.min(startedAt, start);
    }
    if (typeof end === "number" && Number.isFinite(end)) {
      endedAt = endedAt === undefined ? end : Math.max(endedAt, end);
    }
  }
  if (
    typeof startedAt !== "number" ||
    typeof endedAt !== "number" ||
    endedAt < startedAt
  ) {
    return undefined;
  }
  return endedAt - startedAt;
}

/** Build a uniform collapsed label for one activity group. */
export function activityGroupLabel(entries: RenderedTranscriptEntry[]): string {
  const count = countLabel(entries.length, "1 event", "events");
  const durationMs = activityGroupDurationMs(entries);
  if (typeof durationMs !== "number" || durationMs <= 0) return count;
  return `${count} · ${formatMs(durationMs)}`;
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
  const handoffs = entries.flatMap((entry) =>
    entry.kind === "context" && entry.part.event.type === "handoff"
      ? [entry.part.event]
      : [],
  );
  const subagentCount = entries.filter(
    (entry) => entry.kind === "subagent",
  ).length;
  const structuredCount = entries.filter(
    (entry) => entry.kind === "structured_event",
  ).length;
  const attachmentsCount = entries.filter(
    (entry) => entry.kind === "attachments_delivered",
  ).length;
  const resourceEventCount = entries.filter(
    (entry) => entry.kind === "message",
  ).length;
  const handoffSummary =
    handoffs.length === 1
      ? `model handoff to ${handoffs[0].modelId} (${handoffs[0].modelProfile})`
      : handoffs.length > 1
        ? countLabel(handoffs.length, "model handoff", "model handoffs")
        : undefined;

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
    handoffSummary,
    structuredCount > 0
      ? countLabel(structuredCount, "1 structured event", "structured events")
      : undefined,
    attachmentsCount > 0
      ? countLabel(attachmentsCount, "1 file delivery", "file deliveries")
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

/** Keep activity collapsed until the reader explicitly opens it. */
export function activityGroupOpen(userOpen: boolean | null): boolean {
  return userOpen ?? false;
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

  const open = activityGroupOpen(userOpen);

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
              <ShimmerText active={live}>{label}</ShimmerText>
            </span>
            <span className="hidden min-w-0 truncate group-open/activity-run:inline">
              <ShimmerText active={live}>Hide {label}</ShimmerText>
            </span>
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
