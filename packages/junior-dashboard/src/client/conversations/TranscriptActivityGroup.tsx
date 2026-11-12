import { Fragment, type ReactNode } from "react";
import { ChevronRight, Wrench } from "lucide-react";

import { ShimmerText } from "../components/ShimmerText";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { DisplayText } from "../display-text/DisplayText";
import { formatMs } from "../format";
import type { TranscriptViewToolCallPart } from "../types";
import { isMemoryCaptureEvent } from "./conversationMemory";
import {
  isAgentInvocationResultMessage,
  type RenderedTranscriptEntry,
} from "./transcriptRenderModel";
import { cn } from "../styles";
import { useTranscriptSearch } from "./transcriptSearch";
import { TranscriptActivityNesting } from "./TranscriptRailEvent";
import { useTranscriptRowOpen } from "./TranscriptRows";
import { TranscriptSummaryTrigger } from "./TranscriptSummary";
import { toolCallPreview } from "./toolCallPreview";

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
  // Thread cards and Task lines stay in the main view.
  if (entry.kind === "subagent") return false;
  // An agent invocation result left only for its recalled memories is
  // activity of the Turn it started. Its Thread card or Task line shows the
  // outcome.
  if (entry.kind === "message") {
    return isAgentInvocationResultMessage(entry.message);
  }
  // A Turn's captured memories stay visible, so the reader sees what it saved.
  if (entry.kind === "structured_event" && isMemoryCaptureEvent(entry.part)) {
    return false;
  }
  return true;
}

/**
 * Keys of message rows that fold into activity: each quiet reply and the
 * Event messages that started its Turn, and each Event message whose Turn
 * ended without a reply. Event messages wait for the next reply; a message
 * from a person clears them.
 */
export function quietTurnEntryKeys(
  entries: readonly RenderedTranscriptEntry[],
): Set<string> {
  const keys = new Set<string>();
  let eventKeys: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const { message } = entry;
    if (message.role === "user") {
      if (message.noReply) {
        keys.add(entry.key);
        continue;
      }
      eventKeys = message.eventType ? [...eventKeys, entry.key] : [];
      continue;
    }
    if (message.role !== "assistant") continue;
    if (message.quiet) {
      keys.add(entry.key);
      for (const key of eventKeys) keys.add(key);
    }
    eventKeys = [];
  }
  return keys;
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
  const structuredCount = entries.filter(
    (entry) => entry.kind === "structured_event",
  ).length;
  const attachmentsCount = entries.filter(
    (entry) => entry.kind === "attachments_delivered",
  ).length;
  const eventCount = entries.filter(
    (entry) => entry.kind === "message" && entry.message.role !== "assistant",
  ).length;
  const quietReplyCount = entries.filter(
    (entry) => entry.kind === "message" && entry.message.role === "assistant",
  ).length;

  const parts = [
    toolCount > 0
      ? countLabel(toolCount, "1 tool call", "tool calls")
      : undefined,
    reasoningCount > 0
      ? countLabel(reasoningCount, "1 reasoning entry", "reasoning entries")
      : undefined,
    compactionCount > 0
      ? countLabel(compactionCount, "context compacted", "context compacted")
      : undefined,
    structuredCount > 0
      ? countLabel(structuredCount, "1 structured event", "structured events")
      : undefined,
    attachmentsCount > 0
      ? countLabel(attachmentsCount, "1 file delivery", "file deliveries")
      : undefined,
    eventCount > 0 ? countLabel(eventCount, "1 event", "events") : undefined,
    quietReplyCount > 0
      ? countLabel(quietReplyCount, "1 quiet reply", "quiet replies")
      : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.length > 0 ? parts.join(" · ") : activityGroupLabel(entries);
}

/**
 * Pick what a running Turn shows while its activity is closed: the latest
 * reasoning, and the latest tool call after it. A tool call from before the
 * latest reasoning is an earlier step, so it does not show.
 */
export function liveActivityStep(entries: readonly RenderedTranscriptEntry[]): {
  reasoning?: string;
  tool?: TranscriptViewToolCallPart;
} {
  let tool: TranscriptViewToolCallPart | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "tool") {
      tool ??= entry.part;
      continue;
    }
    if (entry.kind !== "reasoning") continue;
    const text = entry.part.redacted ? "" : entry.part.text.trim();
    if (text) return { reasoning: text, tool };
  }
  return { tool };
}

function LiveActivityStep(props: { entries: RenderedTranscriptEntry[] }) {
  const { reasoning, tool } = liveActivityStep(props.entries);
  if (!reasoning && !tool) return null;
  const preview = tool ? toolCallPreview(tool.name, tool.input) : null;
  return (
    <div aria-live="polite" className="mt-1.5 grid min-w-0 gap-1.5">
      {reasoning ? (
        // A new step replaces the text, so it fades in instead of jumping.
        <div
          className="line-clamp-3 text-sm leading-relaxed text-dashboard-text-muted motion-safe:animate-in motion-safe:fade-in-0"
          key={reasoning}
        >
          <DisplayText inline links={false} text={reasoning} />
        </div>
      ) : null}
      {tool ? (
        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-dashboard-text-muted">
          <Wrench
            aria-hidden="true"
            className="size-3.5 shrink-0 text-dashboard-text-faint"
            strokeWidth={2}
          />
          <ShimmerText
            active={tool.status === "running"}
            as="strong"
            className="shrink-0 font-semibold"
          >
            {tool.name}
          </ShimmerText>
          {preview ? (
            <code className="min-w-0 truncate font-mono">{preview}</code>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function hasLiveActivity(entries: RenderedTranscriptEntry[]): boolean {
  return entries.some(
    (entry) => entry.kind === "tool" && entry.part.status === "running",
  );
}

/** Collapse completed non-message activity so chat messages stay primary. */
export function TranscriptActivityGroup(props: {
  entries: RenderedTranscriptEntry[];
  /**
   * The activity of the running Turn. Closed, it also shows the latest step,
   * so the reader can follow along without opening it.
   */
  live?: boolean;
  /** Keeps the group open while it unmounts outside the viewport. */
  openKey?: string;
  renderEntry: (entry: RenderedTranscriptEntry) => ReactNode;
}) {
  const { active: searchActive } = useTranscriptSearch();
  // Activity stays collapsed until the reader opens it.
  const [open, setOpen] = useTranscriptRowOpen(props.openKey);
  const rows = props.entries.map((entry) => (
    <Fragment key={entry.key}>{props.renderEntry(entry)}</Fragment>
  ));
  const label = activityGroupLabel(props.entries);
  const summary = activityGroupSummary(props.entries);
  const live = props.live || hasLiveActivity(props.entries);

  if (searchActive) {
    return (
      <TranscriptActivityNesting.Provider value>
        <div className="grid min-w-0 gap-1">{rows}</div>
      </TranscriptActivityNesting.Provider>
    );
  }

  return (
    <Collapsible className="min-w-0 py-0.5" onOpenChange={setOpen} open={open}>
      <TranscriptSummaryTrigger
        flush
        className={cn(
          "group/activity-run flex items-center gap-1 text-xs leading-tight text-dashboard-text-muted",
          live && "text-dashboard-accent-text/80",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex min-w-0 max-w-full items-center gap-1" />
            }
          >
            <span className="min-w-0 truncate">
              <ShimmerText active={live}>
                {open ? `Hide ${label}` : label}
              </ShimmerText>
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 opacity-55 transition-transform group-aria-expanded/activity-run:rotate-90"
              strokeWidth={2.2}
            />
          </TooltipTrigger>
          <TooltipContent>{summary}</TooltipContent>
        </Tooltip>
      </TranscriptSummaryTrigger>
      {props.live && !open ? (
        <LiveActivityStep entries={props.entries} />
      ) : null}
      {/* Closed rows stay in the page, so browser find can open the group. */}
      <CollapsibleContent hiddenUntilFound>
        <TranscriptActivityNesting.Provider value>
          <div className="mt-1.5 grid min-w-0 gap-1">{rows}</div>
        </TranscriptActivityNesting.Provider>
      </CollapsibleContent>
    </Collapsible>
  );
}
