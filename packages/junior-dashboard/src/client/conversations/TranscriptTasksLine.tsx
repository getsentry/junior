import { ChevronRight } from "lucide-react";

import { statusDotToneClass } from "../components/StatusDot";
import { formatElapsedDuration } from "../format";
import { cn } from "../styles";
import type { TranscriptViewSubagentPart } from "../types";
import { subagentStatusTone } from "./ConversationChildAgents";
import type { RenderedTranscriptEntry } from "./transcriptRenderModel";
import { useTranscriptRowOpen } from "./TranscriptRows";

type TaskStatus = TranscriptViewSubagentPart["status"];
type RenderedTaskEntry = Extract<RenderedTranscriptEntry, { kind: "subagent" }>;

// Line order: work that is still going, then work that needs a person.
const attentionLabels: [TaskStatus, string][] = [
  ["running", "running"],
  ["blocked", "blocked"],
  ["error", "failed"],
  ["aborted", "stopped"],
];

const statusLabels: Record<TaskStatus, string> = {
  aborted: "stopped",
  blocked: "blocked",
  completed: "completed",
  error: "failed",
  running: "running",
};

function taskLabel(part: TranscriptViewSubagentPart): string {
  return part.title ?? part.agentName ?? part.task ?? part.subagentKind;
}

/** First start to last end of a finished run: wall time, not the sum. */
function runDuration(
  entries: readonly RenderedTaskEntry[],
): string | undefined {
  if (entries.some((entry) => entry.part.status === "running")) {
    return undefined;
  }
  const starts = entries.flatMap((entry) =>
    typeof entry.timestamp === "number" ? [entry.timestamp] : [],
  );
  const ends = entries.flatMap((entry) =>
    typeof entry.part.finishedTimestamp === "number"
      ? [entry.part.finishedTimestamp]
      : [],
  );
  if (starts.length === 0 || ends.length === 0) return undefined;
  return formatElapsedDuration(Math.min(...starts), Math.max(...ends));
}

/** Say what a run of Tasks is doing: what needs attention, else done. */
function runSummary(entries: readonly RenderedTaskEntry[]): string {
  if (entries.length === 1) return statusLabels[entries[0]!.part.status];
  const attention = attentionLabels.flatMap(([status, label]) => {
    const count = entries.filter(
      (entry) => entry.part.status === status,
    ).length;
    return count > 0 ? [`${count} ${label}`] : [];
  });
  return attention.length > 0 ? attention.join(" · ") : "completed";
}

function StatusPip(props: { status: TaskStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-xs",
        statusDotToneClass[subagentStatusTone(props.status)],
        props.status === "running" &&
          "animate-pulse motion-reduce:animate-none",
      )}
    />
  );
}

const lineClass =
  "group/tasks flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-1.5 py-0.5 -mx-1.5 text-left font-sans text-sm leading-6 text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus";

/**
 * Collapse a run of Tasks to one line: what it is, what needs attention,
 * and wall time. One Task opens its transcript drawer. More Tasks expand to
 * one row each, and a row opens that Task's drawer.
 */
export function TranscriptTasksLine(props: {
  entries: RenderedTaskEntry[];
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
  openKey: string;
}) {
  const [storedOpen, setOpen] = useTranscriptRowOpen(props.openKey);
  const single = props.entries.length === 1 ? props.entries[0] : undefined;
  const open = !single && storedOpen;
  const summary = runSummary(props.entries);
  const duration = runDuration(props.entries);
  const text = (
    <>
      {single ? (
        <span className="min-w-0 truncate">
          Task · {taskLabel(single.part)}
        </span>
      ) : (
        <span className="shrink-0">{props.entries.length} Tasks</span>
      )}
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{summary}</span>
      {duration ? (
        <span className="shrink-0 tabular-nums text-dashboard-text-faint">
          {duration}
        </span>
      ) : null}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 text-dashboard-text-faint transition-transform group-hover/tasks:text-dashboard-text",
          open && "rotate-90",
        )}
      />
    </>
  );

  if (single) {
    if (!props.onOpenTranscript) {
      return <div className={cn(lineClass, "cursor-default")}>{text}</div>;
    }
    return (
      <button
        aria-label={`Open ${taskLabel(single.part)} transcript`}
        className={lineClass}
        onClick={() => props.onOpenTranscript?.(single.part)}
        type="button"
      >
        {text}
      </button>
    );
  }

  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className={lineClass}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {text}
      </button>
      {open ? (
        <ul className="m-0 mt-1 grid max-w-[37.5rem] list-none gap-0.5 p-0">
          {props.entries.map((entry) => (
            <li key={entry.key}>
              <TaskRow
                entry={entry}
                onOpenTranscript={props.onOpenTranscript}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TaskRow(props: {
  entry: RenderedTaskEntry;
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
}) {
  const { part } = props.entry;
  const label = taskLabel(part);
  const duration = formatElapsedDuration(
    props.entry.timestamp,
    part.finishedTimestamp,
  );
  const content = (
    <>
      <StatusPip status={part.status} />
      <span className="min-w-0 flex-1 truncate text-dashboard-text">
        {label}
      </span>
      <span className="shrink-0 text-dashboard-text-muted">
        {statusLabels[part.status]}
      </span>
      {duration ? (
        <span className="shrink-0 tabular-nums text-dashboard-text-faint">
          {duration}
        </span>
      ) : null}
    </>
  );
  const rowClass =
    "flex w-full min-w-0 items-center gap-2.5 rounded-md bg-transparent px-2 py-1 text-left font-sans text-sm leading-5 text-inherit";
  if (!props.onOpenTranscript) {
    return <div className={rowClass}>{content}</div>;
  }
  return (
    <button
      aria-label={`Open ${label} transcript`}
      className={cn(
        rowClass,
        "cursor-pointer transition-colors hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-dashboard-focus",
      )}
      onClick={() => props.onOpenTranscript?.(part)}
      type="button"
    >
      {content}
    </button>
  );
}
