import { Bot } from "lucide-react";

import { statusDotToneClass } from "../components/StatusDot";
import { Button } from "../components/ui/button";
import { cn } from "../styles";
import type { TranscriptViewSubagentPart } from "../types";
import { subagentStatusTone } from "./ConversationChildAgents";
import type { RenderedTranscriptEntry } from "./transcriptRenderModel";
import { HighlightText } from "./transcriptSearch";

type TaskStatus = TranscriptViewSubagentPart["status"];
type RenderedTaskEntry = Extract<RenderedTranscriptEntry, { kind: "subagent" }>;

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

/** The look of a small chip under a reply. */
export const chipClass =
  "inline-flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md border border-dashboard-border bg-transparent px-2 font-sans text-xs text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus";

/**
 * Show the Tasks of one Turn as small chips under its reply. A click opens
 * the Task transcript drawer.
 */
export function TranscriptTasksLine(props: {
  entries: RenderedTaskEntry[];
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
}) {
  return (
    <ul
      aria-label="Tasks"
      className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0"
    >
      {props.entries.map((entry) => (
        <li className="min-w-0" key={entry.key}>
          <TaskChip entry={entry} onOpenTranscript={props.onOpenTranscript} />
        </li>
      ))}
    </ul>
  );
}

function TaskChip(props: {
  entry: RenderedTaskEntry;
  onOpenTranscript?: (part: TranscriptViewSubagentPart) => void;
}) {
  const { part } = props.entry;
  const label = taskLabel(part);
  const content = (
    <>
      <Bot
        aria-hidden="true"
        className="size-3.5 shrink-0 text-dashboard-text-faint"
        strokeWidth={2}
      />
      <span className="min-w-0 truncate">
        <HighlightText text={label} />
      </span>
      {/* Color only: the running step is the one thing that moves. */}
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          statusDotToneClass[subagentStatusTone(part.status)],
        )}
      />
    </>
  );
  if (!props.onOpenTranscript) {
    return (
      <span
        aria-label={`${label} (${statusLabels[part.status]})`}
        className={cn(chipClass, "cursor-default")}
        role="img"
      >
        {content}
      </span>
    );
  }
  return (
    <Button
      aria-label={`Open ${label} transcript (${statusLabels[part.status]})`}
      className={chipClass}
      onClick={() => props.onOpenTranscript?.(part)}
      size="bare"
      variant="ghost"
    >
      {content}
    </Button>
  );
}
