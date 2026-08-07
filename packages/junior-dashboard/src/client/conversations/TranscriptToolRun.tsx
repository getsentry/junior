import { Fragment, type ReactNode } from "react";

import type {
  RenderedReasoningEntry,
  RenderedToolEntry,
} from "./transcriptRenderModel";
import { useTranscriptSearch } from "./transcriptSearch";

const TOOL_RUN_REVEAL_THRESHOLD = 4;

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

/** Collapse dense consecutive tool and reasoning rows while keeping search open. */
export function TranscriptToolRun(props: {
  autoCollapse: boolean;
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

  if (
    !props.autoCollapse ||
    props.entries.length < TOOL_RUN_REVEAL_THRESHOLD ||
    searchActive
  ) {
    return <>{rows}</>;
  }

  return (
    <details className="group/tool-run min-w-0">
      <summary className="group flex w-full cursor-pointer list-none items-center gap-2 py-1.5 text-left font-mono text-xs leading-tight text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden">
        <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
        <span className="shrink-0 group-open/tool-run:hidden">
          show {label}
        </span>
        <span className="hidden shrink-0 group-open/tool-run:inline">
          hide {label}
        </span>
        <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
      </summary>
      <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        {rows}
      </div>
    </details>
  );
}
