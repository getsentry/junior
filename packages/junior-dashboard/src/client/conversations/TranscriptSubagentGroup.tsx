import { ChevronDown, ChevronRight } from "lucide-react";

import { StatusChip } from "../components/StatusChip";
import { statusDotToneClass } from "../components/StatusDot";
import { formatElapsedDuration } from "../format";
import { cn } from "../styles";
import type { TranscriptViewSubagentPart } from "../types";
import { subagentStatusTone } from "./ConversationChildAgents";
import type { RenderedTranscriptEntry } from "./transcriptRenderModel";
import { useTranscriptRowOpen } from "./TranscriptRows";

type SubagentStatus = TranscriptViewSubagentPart["status"];
type RenderedSubagentEntry = Extract<
  RenderedTranscriptEntry,
  { kind: "subagent" }
>;

// Header order: work that is still going, then work that needs a person.
const attentionLabels: [SubagentStatus, string][] = [
  ["running", "running"],
  ["blocked", "blocked"],
  ["error", "failed"],
  ["aborted", "stopped"],
];

const MAX_PIPS = 24;

function agentLabel(part: TranscriptViewSubagentPart): string {
  return part.agentName ?? part.subagentKind;
}

function entryEnd(
  entry: RenderedSubagentEntry,
  nowMs: number,
): number | undefined {
  return (
    entry.part.finishedTimestamp ??
    (entry.part.status === "running" ? nowMs : undefined)
  );
}

/** First start to last end of the group: wall time, not the sum. */
function groupSpan(
  entries: readonly RenderedSubagentEntry[],
  nowMs: number,
): { end: number; start: number } | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const entry of entries) {
    if (typeof entry.timestamp === "number") {
      start = Math.min(start ?? entry.timestamp, entry.timestamp);
    }
    const entryEndMs = entryEnd(entry, nowMs);
    if (typeof entryEndMs === "number") {
      end = Math.max(end ?? entryEndMs, entryEndMs);
    }
  }
  return start === undefined || end === undefined || end <= start
    ? undefined
    : { end, start };
}

function laneStyle(
  entry: RenderedSubagentEntry,
  span: { end: number; start: number },
  nowMs: number,
): { left: string; width: string } | undefined {
  const end = entryEnd(entry, nowMs);
  if (typeof entry.timestamp !== "number" || end === undefined) {
    return undefined;
  }
  const total = span.end - span.start;
  const left = ((entry.timestamp - span.start) / total) * 100;
  const width = ((end - entry.timestamp) / total) * 100;
  return { left: `${left}%`, width: `${width}%` };
}

function StatusPip(props: { className?: string; status: SubagentStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-xs",
        statusDotToneClass[subagentStatusTone(props.status)],
        props.status === "running" &&
          "animate-pulse motion-reduce:animate-none",
        props.className,
      )}
    />
  );
}

/**
 * Render a run of child agents as one card. The header shows one pip per
 * child agent in start order, what needs attention, and wall time. Rows that
 * need attention (not completed) always show. Completed rows fold until the
 * reader opens the card. Each row has a thin lane that places its run time
 * inside the group span, and opens the child transcript.
 */
export function TranscriptSubagentGroup(props: {
  entries: RenderedSubagentEntry[];
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
  openKey: string;
}) {
  const [open, setOpen] = useTranscriptRowOpen(props.openKey);
  const nowMs = Date.now();
  const span = groupSpan(props.entries, nowMs);
  const running = props.entries.some(
    (entry) => entry.part.status === "running",
  );
  const duration =
    span && !running ? formatElapsedDuration(span.start, span.end) : undefined;
  const attention = attentionLabels.flatMap(([status, label]) => {
    const count = props.entries.filter(
      (entry) => entry.part.status === status,
    ).length;
    return count > 0 ? [{ count, label, status }] : [];
  });
  const completedCount = props.entries.filter(
    (entry) => entry.part.status === "completed",
  ).length;
  const rows = open
    ? props.entries
    : props.entries.filter((entry) => entry.part.status !== "completed");
  const pips = props.entries.slice(0, MAX_PIPS);
  const hiddenPips = props.entries.length - pips.length;

  return (
    <div className="w-full min-w-0 max-w-[37.5rem] overflow-hidden rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel">
      <button
        aria-expanded={open}
        className="group/subagents flex w-full min-w-0 cursor-pointer items-center gap-2.5 bg-transparent px-3 py-2 text-left text-xs leading-5 text-inherit transition-colors hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex max-w-56 shrink-0 flex-wrap items-center gap-0.75"
        >
          {pips.map((entry) => (
            <StatusPip key={entry.key} status={entry.part.status} />
          ))}
          {hiddenPips > 0 ? (
            <span className="text-2xs leading-none text-dashboard-text-faint">
              +{hiddenPips}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-sans text-sm font-semibold text-dashboard-text">
          {props.entries.length} agents
        </span>
        {attention.map(({ count, label, status }) => (
          <StatusChip
            className="shrink-0"
            key={status}
            size="compact"
            tone={subagentStatusTone(status)}
          >
            {`${count} ${label}`}
          </StatusChip>
        ))}
        {duration ? (
          <span className="ml-auto shrink-0 tabular-nums text-dashboard-text-muted">
            {duration}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-dashboard-text-faint transition-transform group-hover/subagents:text-dashboard-text group-aria-expanded/subagents:rotate-90",
            !duration && "ml-auto",
          )}
        />
      </button>
      {rows.map((entry) => (
        <SubagentGroupRow
          entry={entry}
          key={entry.key}
          lane={span ? laneStyle(entry, span, nowMs) : undefined}
          onOpenTranscript={props.onOpenTranscript}
        />
      ))}
      {!open && completedCount > 0 ? (
        <button
          className="flex w-full cursor-pointer items-center gap-1.5 border-0 border-t border-solid border-dashboard-border-subtle bg-transparent px-3 py-1.5 text-left font-sans text-xs text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
          onClick={() => setOpen(true)}
          type="button"
        >
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          {completedCount} completed
        </button>
      ) : null}
    </div>
  );
}

function SubagentGroupRow(props: {
  entry: RenderedSubagentEntry;
  lane?: { left: string; width: string };
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
}) {
  const { part } = props.entry;
  const label = agentLabel(part);
  // A row that needs attention keeps its task title, like the single card.
  const headline =
    part.status === "completed" ? undefined : (part.title ?? part.task);
  const duration = formatElapsedDuration(
    props.entry.timestamp,
    part.finishedTimestamp,
  );
  const content = (
    <>
      <StatusPip status={part.status} />
      <span className="min-w-0">
        <span className="block truncate font-sans text-sm font-medium text-dashboard-text">
          {label}
        </span>
        {headline ? (
          <span className="block truncate text-sm leading-snug text-dashboard-text-subtle">
            {headline}
          </span>
        ) : null}
        <span className="sr-only">{part.status}</span>
      </span>
      <span
        aria-hidden="true"
        className="relative hidden h-1 rounded-full bg-dashboard-fill-soft sm:block"
      >
        {props.lane ? (
          <span
            className={cn(
              "absolute inset-y-0 min-w-0.75 rounded-full opacity-80",
              statusDotToneClass[subagentStatusTone(part.status)],
            )}
            style={props.lane}
          />
        ) : null}
      </span>
      <span className="text-right tabular-nums text-dashboard-text-muted">
        {duration}
      </span>
      {props.onOpenTranscript ? (
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-dashboard-text-faint transition-colors group-hover/subagent-row:text-dashboard-text"
        />
      ) : (
        <span />
      )}
    </>
  );
  const rowClass =
    "group/subagent-row grid w-full min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_3.5rem_1rem] items-center gap-x-2.5 border-0 border-t border-solid border-dashboard-border-subtle bg-transparent px-3 py-1.5 text-left text-xs leading-5 text-inherit sm:grid-cols-[0.5rem_minmax(0,1fr)_7.5rem_3.5rem_1rem]";

  if (!props.onOpenTranscript) {
    return <div className={rowClass}>{content}</div>;
  }
  return (
    <button
      aria-label={`Open ${label} transcript, ${part.status}`}
      className={cn(
        rowClass,
        "cursor-pointer transition-colors hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
      )}
      onClick={() => props.onOpenTranscript?.(part)}
      type="button"
    >
      {content}
    </button>
  );
}
