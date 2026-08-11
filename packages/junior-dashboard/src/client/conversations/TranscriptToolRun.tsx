import { Fragment, type ReactNode } from "react";
import { ChevronRight, Wrench } from "lucide-react";

import type {
  RenderedReasoningEntry,
  RenderedToolEntry,
} from "./transcriptRenderModel";
import { useTranscriptSearch } from "./transcriptSearch";

type ToolRunEntry = RenderedReasoningEntry | RenderedToolEntry;

function runLabel(entries: ToolRunEntry[]): string {
  const toolCount = entries.filter((entry) => entry.kind === "tool").length;
  const reasoningCount = entries.length - toolCount;
  const tools = toolCount === 1 ? "1 tool call" : `${toolCount} tool calls`;
  const reasoning =
    reasoningCount === 1
      ? "1 reasoning entry"
      : `${reasoningCount} reasoning entries`;
  if (toolCount === 0) return reasoning;
  if (reasoningCount === 0) return tools;
  return `${tools} and ${reasoning}`;
}

function hasRunningTool(entries: ToolRunEntry[]): boolean {
  return entries.some(
    (entry) => entry.kind === "tool" && entry.part.status === "running",
  );
}

/** Collapse completed tool and reasoning runs so chat messages stay primary. */
export function TranscriptToolRun(props: {
  entries: ToolRunEntry[];
  renderReasoning: (entry: RenderedReasoningEntry) => ReactNode;
  renderTool: (entry: RenderedToolEntry) => ReactNode;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const rows = props.entries.map((entry) => (
    <Fragment key={entry.key}>
      {entry.kind === "reasoning"
        ? props.renderReasoning(entry)
        : props.renderTool(entry)}
    </Fragment>
  ));
  const label = runLabel(props.entries);

  // Keep live tool runs open. Collapse once every call has finished.
  if (searchActive || hasRunningTool(props.entries)) {
    return <>{rows}</>;
  }

  return (
    <details className="group/tool-run min-w-0">
      <summary className="group flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-left text-xs leading-tight text-dashboard-text-muted transition-colors hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden">
        <Wrench
          aria-hidden="true"
          className="size-3 shrink-0 opacity-70"
          strokeWidth={2.2}
        />
        <span className="min-w-0 truncate group-open/tool-run:hidden">
          {label}
        </span>
        <span className="hidden min-w-0 truncate group-open/tool-run:inline">
          Hide {label}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-3 shrink-0 opacity-60 transition-transform group-open/tool-run:rotate-90"
          strokeWidth={2.2}
        />
      </summary>
      <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        {rows}
      </div>
    </details>
  );
}
