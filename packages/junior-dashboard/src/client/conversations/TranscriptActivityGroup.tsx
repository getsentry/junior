import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight, Layers } from "lucide-react";

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
  // Keep terminal failures visible; collapsed chips hide the red tool status.
  if (entry.kind === "tool") return entry.part.status !== "error";
  if (entry.kind === "subagent") {
    return entry.part.status !== "error" && entry.part.status !== "aborted";
  }
  return true;
}

/** Build a compact summary for one collapsed activity group. */
export function activityGroupLabel(entries: RenderedTranscriptEntry[]): string {
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

  const onlyToolsAndReasoning =
    toolCount + reasoningCount === entries.length && entries.length > 0;
  if (onlyToolsAndReasoning) {
    const tools =
      toolCount === 0
        ? undefined
        : countLabel(toolCount, "1 tool call", "tool calls");
    const reasoning =
      reasoningCount === 0
        ? undefined
        : countLabel(reasoningCount, "1 reasoning entry", "reasoning entries");
    if (tools && reasoning) return `${tools} and ${reasoning}`;
    return tools ?? reasoning ?? "1 action";
  }

  if (entries.length === 1) {
    if (compactionCount === 1) return "context compacted";
    if (handoffCount === 1) return "model handoff";
    if (subagentCount === 1) return "1 subagent";
    if (structuredCount === 1) return "1 event";
    if (resourceEventCount === 1) return "1 resource event";
    if (toolCount === 1) return "1 tool call";
    if (reasoningCount === 1) return "1 reasoning entry";
  }

  const actions = countLabel(entries.length, "1 action", "actions");
  const preferred = [
    toolCount > 0
      ? countLabel(toolCount, "1 tool call", "tool calls")
      : undefined,
    compactionCount > 0
      ? countLabel(compactionCount, "context compacted", "context compacted")
      : undefined,
    handoffCount > 0
      ? countLabel(handoffCount, "model handoff", "model handoffs")
      : undefined,
    subagentCount > 0
      ? countLabel(subagentCount, "1 subagent", "subagents")
      : undefined,
  ].filter((value): value is string => value !== undefined);

  if (preferred.length > 0) {
    return `${actions} · ${preferred.join(" · ")}`;
  }
  return actions;
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
  const live = hasLiveActivity(props.entries);

  if (searchActive) {
    return (
      <div className={activityLaneClass({ live: false, open: true })}>
        <div className="grid min-w-0 gap-1">{rows}</div>
      </div>
    );
  }

  const open = activityGroupOpen({
    hasLiveActivity: live,
    userOpen,
  });

  return (
    <details
      className={cn("group/activity-run min-w-0", activityLaneClass({ live, open }))}
      open={open}
    >
      <summary
        className={cn(
          "group flex w-full max-w-full cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-left text-xs leading-tight text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden",
          live && "text-cyan-100/80",
        )}
        onClick={(event) => {
          event.preventDefault();
          setUserOpen(!open);
        }}
      >
        <Layers
          aria-hidden="true"
          className={cn("size-3 shrink-0 opacity-70", live && "text-cyan-200")}
          strokeWidth={2.2}
        />
        <span className="min-w-0 flex-1 truncate group-open/activity-run:hidden">
          {label}
        </span>
        <span className="hidden min-w-0 flex-1 truncate group-open/activity-run:inline">
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
          className="size-3 shrink-0 opacity-60 transition-transform group-open/activity-run:rotate-90"
          strokeWidth={2.2}
        />
      </summary>
      <div className="grid min-w-0 gap-1 border-t border-white/[0.06] px-2 py-1.5">
        {rows}
      </div>
    </details>
  );
}

function activityLaneClass(args: { live: boolean; open: boolean }): string {
  return cn(
    "min-w-0 overflow-hidden rounded-lg border bg-white/[0.02]",
    args.live
      ? "border-cyan-300/25 bg-cyan-300/[0.04]"
      : args.open
        ? "border-white/[0.1] bg-white/[0.03]"
        : "border-white/[0.08]",
  );
}
